///<reference path="../node_modules/grafana-sdk-mocks/app/headers/common.d.ts" />

import _ from 'lodash';
import moment from 'moment';
import * as dateMath from 'app/core/utils/datemath';
import * as Druid from 'druid.d'
import angular from "angular";

const DRUID_DATASOURCE_PATH = '/druid/v2/datasources';

export default class DruidDatasource {
  id: number;
  name: string;
  url: string;
  q: any;
  backendSrv: any;
  templateSrv: any;
  basicAuth: any;
  supportMetrics: any;
  periodGranularity: any;
  GRANULARITIES = [
    ['second', moment.duration(1, 'second')],
    ['minute', moment.duration(1, 'minute')],
    ['fifteen_minute', moment.duration(15, 'minute')],
    ['thirty_minute', moment.duration(30, 'minute')],
    ['hour', moment.duration(1, 'hour')],
    ['day', moment.duration(1, 'day')],
    ['week', moment.duration(1, 'week')],
    ['month', moment.duration(1, 'month')],
    ['quarter', moment.duration(1, 'quarter')],
    ['year', moment.duration(1, 'year')]
  ];
  filterTemplateExpanders = {
    "selector": ['value'],
    "array": ['value'],
    "regex": ['pattern'],
    "javascript": ['function'],
    "search": []
  };
  scopedVars: any = {};


  /** @ngInject */
  constructor(instanceSettings, $q, backendSrv, templateSrv) {
    this.name = instanceSettings.name;
    this.id = instanceSettings.id;
    this.url = instanceSettings.url;
    this.backendSrv = backendSrv;
    this.q = $q;
    this.templateSrv = templateSrv;
    this.basicAuth = instanceSettings.basicAuth;
    instanceSettings.jsonData = instanceSettings.jsonData || {};
    this.supportMetrics = true;
    this.periodGranularity = instanceSettings.jsonData.periodGranularity;
  }

  query(options) {
    const from = this.dateToMoment(options.range.from, false);
    const to = this.dateToMoment(options.range.to, true);
    this.scopedVars[options.panelId] = options.scopedVars;

    let promises = options.targets.map(target => {
      if (target.hide === true || _.isEmpty(target.druidDS) || (_.isEmpty(target.aggregators) && target.queryType !== "select")) {
        const d = this.q.defer();
        d.resolve([]);
        return d.promise;
      }
      const maxDataPointsByResolution = options.maxDataPoints;
      const maxDataPointsByConfig = target.maxDataPoints ? target.maxDataPoints : Number.MAX_VALUE;
      const maxDataPoints = Math.min(maxDataPointsByResolution, maxDataPointsByConfig);
      let customGranularity = this.templateSrv.replace(target.customGranularity, this.scopedVars[options.panelId]);
      let shouldOverrideGranularity = target.shouldOverrideGranularity && (customGranularity !== 'auto');
      let granularity = shouldOverrideGranularity ? customGranularity : this.computeGranularity(from, to, maxDataPoints);
      //Round up to start of an interval
      //Width of bar chars in Grafana is determined by size of the smallest interval
      const roundedFrom = granularity === "all" ? from : this.roundUpStartTime(from, granularity);
      if (this.periodGranularity != "") {
        if (granularity === 'day') {
          granularity = { "type": "period", "period": "P1D", "timeZone": this.periodGranularity }
        }
      }
      return this.doQuery(roundedFrom, to, granularity, target, options.panelId)
        .then(response => {
          this.applyMultiplier(target.aggregators, ['longSum', 'doubleSum'], response, options.panelId);
          this.applyMultiplier(target.postAggregators, ['fieldAccess', 'arithmetic'], response, options.panelId);
          return response;
        });
    });

    return this.q.all(promises).then(results => {
      return { data: _.flatten(results) };
    });
  }

  applyMultiplier(aggregator, types, data, panelId) {
    if (!aggregator) return;
    aggregator.filter(a => _.includes(types, a.type) && a.extMultiplier)
      .forEach(a => {
        let name = this.replaceTemplateValuesNum(a.name, panelId),
            extMultiplier = this.replaceTemplateValuesNum(a.extMultiplier, panelId);
        // transform timeseries
        data.filter(r => r.target === name)
          .flatMap(r => r.datapoints)
          .forEach(dp => dp[0] = dp[0] * extMultiplier);
        // transform tables
        data.filter(set => set.columns && set.rows && set.columns.find(v => v.text === name))
          .forEach(set => {
              let i = set.columns.findIndex(v => v.text === name);
              set.rows.forEach(r => r[i] *= this.replaceTemplateValuesNum(extMultiplier, panelId));
          });
    });
  }

  doQuery(from, to, granularity, target, panelId) {
    let datasource = target.druidDS;
    let filters = target.filters;
    let aggregators = this.replaceTemplateValues(target.aggregators, ['name', 'fieldName', 'fields'], panelId).map(this.splitArrayFields);
    let postAggregators = target.postAggregators
        ? this.replaceTemplateValues(target.postAggregators, ['name', 'fieldName', 'fields'], panelId).map(this.splitArrayFields)
        : [];
    let groupBy = _.map(target.groupBy, (e) => { return this.templateSrv.replace(e, this.scopedVars[panelId]) });
    let limitSpec = null;
    let metricNames = this.getMetricNames(aggregators, postAggregators);
    let intervals = this.getQueryIntervals(from, to);
    let promise = null;

    let selectMetrics = target.selectMetrics;
    let selectDimensions = target.selectDimensions;
    let selectThreshold = target.selectThreshold;
    if (!selectThreshold) {
      selectThreshold = 5;
    }

    if (target.queryType === 'topN') {
      let threshold = this.replaceTemplateValuesNum(target.limit, panelId);
      let metric = this.templateSrv.replace(target.druidMetric, this.scopedVars[panelId]);
      let metricToShow = this.templateSrv.replace(target.druidMetricToShow, this.scopedVars[panelId]);
      let dimension = this.templateSrv.replace(target.dimension, this.scopedVars[panelId]);
      promise = this.topNQuery(datasource, intervals, granularity, filters, aggregators, postAggregators, threshold, metric, dimension, panelId)
        .then(response => {
          return this.convertTopNData(response.data, dimension, metricToShow ? metricToShow : metric);
        });
    }
    else if (target.queryType === 'groupBy') {
      limitSpec = this.getLimitSpec(this.replaceTemplateValuesNum(target.limit, panelId), target.orderBy, panelId);
      promise = this.groupByQuery(datasource, intervals, granularity, filters, aggregators, postAggregators, groupBy, limitSpec, panelId)
        .then(response => {
          return target.tableType === 'table'
              ? this.convertGroupByDataAsTable(response.data, groupBy, metricNames)
              : this.convertGroupByData(response.data, groupBy, metricNames);
        });
    }
    else if (target.queryType === 'select') {
      promise = this.selectQuery(datasource, intervals, granularity, selectDimensions, selectMetrics, filters, selectThreshold, panelId);
      return promise.then(response => {
        return this.convertSelectData(response.data);
      });
    }
    else {
      promise = this.timeSeriesQuery(datasource, intervals, granularity, filters, aggregators, postAggregators, panelId)
        .then(response => {
          return this.convertTimeSeriesData(response.data, metricNames);
        });
    }
    /*
      At this point the promise will return an list of time series of this form
    [
      {
        target: <metric name>,
        datapoints: [
          [<metric value>, <timestamp in ms>],
          ...
        ]
      },
      ...
    ]

    Druid calculates metrics based on the intervals specified in the query but returns a timestamp rounded down.
    We need to adjust the first timestamp in each time series
    */
    return promise.then(metrics => {
      let fromMs = this.formatTimestamp(from);
      metrics.forEach(metric => {
        if (metric.datapoints && !_.isEmpty(metric.datapoints[0]) && metric.datapoints[0][1] < fromMs) {
          metric.datapoints[0][1] = fromMs;
        }
      });
      return metrics;
    });
  };

  splitArrayFields(aggregator) {
    if ((aggregator.type === 'cardinality' || aggregator.type === 'javascript') &&
      typeof aggregator.fieldNames === 'string') {
      aggregator.fieldNames = aggregator.fieldNames.split(',')
    }
    return aggregator;
  }

  selectQuery(datasource: string, intervals: Array<string>, granularity: Druid.Granularity,
              dimensions: Array<string | Object>, metric: Array<string | Object>, filters: Array<Druid.DruidFilter>,
              selectThreshold: Object, panelId: number) {
    let query: Druid.DruidSelectQuery = {
      "queryType": "select",
      "dataSource": datasource,
      "granularity": granularity,
      "pagingSpec": { "pagingIdentifiers": {}, "threshold": selectThreshold },
      "dimensions": dimensions,
      "metrics": metric,
      "intervals": intervals
    };

    if (filters && filters.length > 0) {
      query.filter = this.buildFilterTree(filters, panelId);
    }

    return this.druidQuery(query);
  };

  timeSeriesQuery(datasource: string, intervals: Array<string>, granularity: Druid.Granularity,
                  filters: Array<Druid.DruidFilter>, aggregators: Object, postAggregators: Object,
                  panelId: number) {
    let query: Druid.DruidTimeSeriesQuery = {
      queryType: "timeseries",
      dataSource: datasource,
      granularity: granularity,
      aggregations: aggregators,
      postAggregations: postAggregators,
      intervals: intervals
    };

    if (filters && filters.length > 0) {
      query.filter = this.buildFilterTree(filters, panelId);
    }

    return this.druidQuery(query);
  };

  topNQuery(datasource: string, intervals: Array<string>, granularity: Druid.Granularity,
            filters: Array<Druid.DruidFilter>, aggregators: Object, postAggregators: Object,
            threshold: number, metric: string | Object, dimension: string | Object, panelId: number) {
    const query: Druid.DruidTopNQuery = {
      queryType: "topN",
      dataSource: datasource,
      granularity: granularity,
      threshold: threshold,
      dimension: dimension,
      metric: metric,
      aggregations: aggregators,
      postAggregations: postAggregators,
      intervals: intervals
    };

    if (filters && filters.length > 0) {
      query.filter = this.buildFilterTree(filters, panelId);
    }

    return this.druidQuery(query);
  };

  groupByQuery(datasource: string, intervals: Array<string>, granularity: Druid.Granularity,
               filters: Array<Druid.DruidFilter>, aggregators: Object, postAggregators: Object, groupBy: Array<string>,
               limitSpec: Druid.LimitSpec, panelId: number) {
    const query: Druid.DruidGroupByQuery = {
      queryType: "groupBy",
      dataSource: datasource,
      granularity: granularity,
      dimensions: groupBy,
      aggregations: aggregators,
      postAggregations: postAggregators,
      intervals: intervals,
      limitSpec: limitSpec,
    };

    if (filters && filters.length > 0) {
      query.filter = this.buildFilterTree(filters, panelId);
    }

    return this.druidQuery(query);
  };

  druidQuery(query: Druid.AbstractDruidQuery) {
    const options = {
      method: 'POST',
      url: this.url + '/druid/v2/',
      data: query
    };
    return this.backendSrv.datasourceRequest(options);
  };

  getLimitSpec(limitNum, orderBy, panelId) {
    return {
      "type": "default",
      "limit": limitNum,
      "columns": !orderBy ? null : orderBy.map(col => {
        let columnName = this.templateSrv.replace(col, this.scopedVars[panelId]);
        if (columnName.startsWith('!')) {
          return {
            "dimension": columnName.substr(1),
            "direction": "ASCENDING"
          };
        } else {
          return {
            "dimension": columnName,
            "direction": "DESCENDING"
          };
        }
      })
    };
  }

  metricFindQuery(query) {
    var range = angular.element('grafana-app').injector().get('timeSrv').timeRangeForUrl(),
      from = this.dateToMoment(range.from, false),
      to = this.dateToMoment(range.to, true),
      intervals = this.getQueryIntervals(from, to);

    var q = JSON.parse(this.templateSrv.replace(query));
    if (q.filter.fields) q.filter.fields = q.filter.fields.filter(f => !f.value || f.value !== 'skipFilter');
    q.intervals = intervals;

    return this.druidQuery(q)
      .then(response => {
        return _.map(response.data[0].result, (e) => {
          return { "text": e[q.dimension] };
        });
      });
  }

  testDatasource() {
    return this.get(DRUID_DATASOURCE_PATH).then(() => {
      return { status: "success", message: "Druid Data source is working", title: "Success" };
    });
  }

  //Get list of available datasources
  getDataSources() {
    return this.get(DRUID_DATASOURCE_PATH).then(response => {
      return response.data;
    });
  };

  getDimensionsAndMetrics(datasource) {
    return this.get(DRUID_DATASOURCE_PATH + '/' + datasource).then(response => {
      return response.data;
    });
  };

  getFilterValues(target, panelRange, query, panelId) {
    const topNquery: any = {
      "queryType": "topN",
      "dataSource": target.druidDS,
      "granularity": 'all',
      "threshold": 10,
      "dimension": target.currentFilter.dimension,
      "metric": "count",
      "aggregations": [{ "type": "count", "name": "count" }],
      "intervals": this.getQueryIntervals(panelRange.from, panelRange.to)
    };

    let filters = [];
    if (target.filters) {
      filters =
        filters = _.cloneDeep(target.filters);
    }
    filters.push({
      "type": "search",
      "dimension": target.currentFilter.dimension,
      "query": {
        "type": "insensitive_contains",
        "value": query
      }
    });
    topNquery.filter = this.buildFilterTree(filters, panelId);

    return this.druidQuery(topNquery);
  };

  get(relativeUrl, params?) {
    return this.backendSrv.datasourceRequest({
      method: 'GET',
      url: this.url + relativeUrl,
      params: params,
    });
  };

  buildFilterTree(filters, panelId): Druid.DruidFilter {
    //Do template variable replacement
    const replacedFilters = filters
      .map(filter => {
        return this.replaceTemplateValues(filter, this.filterTemplateExpanders[filter.type], panelId);
      })
      .filter(f => f[this.filterTemplateExpanders[f.type]])
      .map(f => {
        f.dimension = this.templateSrv.replace(f.dimension, this.scopedVars[panelId]);
        if (f.type !== 'array') return f;
        if (f.value.startsWith('skipFilter')) return undefined;
        let negate = f.value.startsWith('!') || f.negate;
        if (f.value.startsWith('!')) f.value = f.value.substr(1);
        return {
          'type': 'or',
          'negate': negate,
          'fields':
              f.value.split(',').map(value => {
                let copy = _.omit(f, 'negate');
                copy.value = value;
                copy.type = 'selector';
                return copy;
              })
        };
      })
      .filter(f => f)
      .map(filter => {
        const finalFilter = _.omit(filter, 'negate');
        if (filter.negate) {
          return {"type": "not", "field": finalFilter};
        }
        return finalFilter;
      });
    if (replacedFilters && replacedFilters.length > 0) {
      if (replacedFilters.length === 1) {
        return replacedFilters[0];
      }
      return {
        "type": "and",
        "fields": replacedFilters
      };
    }
    return null;
  }

  getQueryIntervals(from, to) {
    return [from.toISOString() + '/' + to.toISOString()];
  }

  getMetricNames(aggregators, postAggregators) {
    const displayAggs = _.filter(aggregators, agg => {
      return agg.type !== 'approxHistogramFold' && agg.hidden != true;
    });
    return _.union(_.map(displayAggs, 'name'), _.map(postAggregators, 'name'));
  }

  formatTimestamp(ts) {
    return moment(ts).format('X') * 1000;
  }

  convertTimeSeriesData(md, metrics) {
    return metrics.map(metric => {
      return {
        target: metric,
        datapoints: md.map(item => {
          return [
            item.result[metric],
            this.formatTimestamp(item.timestamp)
          ];
        })
      };
    });
  }

  getGroupName(groupBy, metric) {
    return groupBy.map(dim => {
      return metric.event[dim];
    })
      .join("-");
  }

  convertTopNData(md, dimension, metric) {
    /*
      Druid topN results look like this:
      [
        {
          "timestamp": "ts1",
          "result": [
            {"<dim>": d1, "<metric>": mv1},
            {"<dim>": d2, "<metric>": mv2}
          ]
        },
        {
          "timestamp": "ts2",
          "result": [
            {"<dim>": d1, "<metric>": mv3},
            {"<dim>": d2, "<metric>": mv4}
          ]
        },
        ...
      ]
    */

    /*
      First, we need make sure that the result for each
      timestamp contains entries for all distinct dimension values
      in the entire list of results.

      Otherwise, if we do a stacked bar chart, Grafana doesn't sum
      the metrics correctly.
    */

    //Get the list of all distinct dimension values for the entire result set
    const dVals = md.reduce((dValsSoFar, tsItem) => {
      const dValsForTs = _.map(tsItem.result, dimension);
      return _.union(dValsSoFar, dValsForTs);
    }, {});

    //Add null for the metric for any missing dimension values per timestamp result
    md.forEach(tsItem => {
      const dValsPresent = _.map(tsItem.result, dimension);
      const dValsMissing = _.difference(dVals, dValsPresent);
      dValsMissing.forEach(dVal => {
        const nullPoint = {};
        nullPoint[dimension] = dVal;
        nullPoint[metric] = null;
        tsItem.result.push(nullPoint);
      });
      return tsItem;
    });

    //Re-index the results by dimension value instead of time interval
    const mergedData = md.map(item => {
      /*
        This first map() transforms this into a list of objects
        where the keys are dimension values
        and the values are [metricValue, unixTime] so that we get this:
          [
            {
              "d1": [mv1, ts1],
              "d2": [mv2, ts1]
            },
            {
              "d1": [mv3, ts2],
              "d2": [mv4, ts2]
            },
            ...
          ]
      */
      const timestamp = this.formatTimestamp(item.timestamp);
      const keys = _.map(item.result, dimension);
      const vals = _.map(item.result, metric).map(val => { return [val, timestamp]; });
      return _.zipObject(keys, vals);
    })
      .reduce((prev, curr) => {
        /*
          Reduce() collapses all of the mapped objects into a single
          object.  The keys are dimension values
          and the values are arrays of all the values for the same key.
          The _.assign() function merges objects together and it's callback
          gets invoked for every key,value pair in the source (2nd argument).
          Since our initial value for reduce() is an empty object,
          the _.assign() callback will get called for every new val
          that we add to the final object.
        */
        return _.assignWith(prev, curr, (pVal, cVal) => {
          if (pVal) {
            pVal.push(cVal);
            return pVal;
          }
          return [cVal];
        });
      }, {});

    //Convert object keyed by dimension values into an array
    //of objects {target: <dimVal>, datapoints: <metric time series>}
    return _.map(mergedData, (vals, key) => {
      return {
        target: key,
        datapoints: vals
      };
    });
  }

  convertGroupByDataAsTable(md, groupBy, metrics) {
    let res: any = {};
    res.type = 'table';
    res.columns = metrics.reduce((a, v) => {
      a.push({text: v});
      return a;
    }, groupBy.reduce((a, v) => {
      a.push({text: v});
      return a;
    }, []));
    res.rows = md.reduce((a, d) => {
      a.push(res.columns.reduce((aa, m) => {
        aa.push(d.event[m.text]);
        return aa;
      }, []));
      return a;
    }, []);
    res.meta = {rowCount: md.length};
    return [res];
  }

  convertGroupByData(md, groupBy, metrics) {
    const mergedData = md.map(item => {
      /*
        The first map() transforms the list Druid events into a list of objects
        with keys of the form "<groupName>:<metric>" and values
        of the form [metricValue, unixTime]
      */
      const groupName = this.getGroupName(groupBy, item);
      const keys = metrics.map(metric => {
        return groupName + ":" + metric;
      });
      const vals = metrics.map(metric => {
        return [
          item.event[metric],
          this.formatTimestamp(item.timestamp)
        ];
      });
      return _.zipObject(keys, vals);
    })
      .reduce((prev, curr) => {
        /*
          Reduce() collapses all of the mapped objects into a single
          object.  The keys are still of the form "<groupName>:<metric>"
          and the values are arrays of all the values for the same key.
          The _.assign() function merges objects together and it's callback
          gets invoked for every key,value pair in the source (2nd argument).
          Since our initial value for reduce() is an empty object,
          the _.assign() callback will get called for every new val
          that we add to the final object.
        */
        return _.assignWith(prev, curr, (pVal, cVal) => {
          if (pVal) {
            pVal.push(cVal);
            return pVal;
          }
          return [cVal];
        });
      }, {});

    return _.map(mergedData, (vals, key) => {
      /*
        Second map converts the aggregated object into an array
      */
      return {
        target: key,
        datapoints: vals
      };
    });
  }

  convertSelectData(data) {
    const resultList = _.map(data, "result");
    const eventsList = _.map(resultList, "events");
    const eventList = _.flatten(eventsList);
    const result = {};
    for (let i = 0; i < eventList.length; i++) {
      const event = eventList[i].event;
      const timestamp = event.timestamp;
      if (_.isEmpty(timestamp)) {
        continue;
      }
      for (const key in event) {
        if (key !== "timestamp") {
          if (!result[key]) {
            result[key] = { "target": key, "datapoints": [] };
          }
          result[key].datapoints.push([event[key], timestamp]);
        }
      }
    }
    return _.values(result);
  }

  dateToMoment(date, roundUp) {
    if (date === 'now') {
      return moment();
    }
    date = dateMath.parse(date, roundUp);
    return moment(date.valueOf());
  }

  computeGranularity(from, to, maxDataPoints) {
    const intervalSecs = to.unix() - from.unix();
    /*
      Find the smallest granularity for which there
      will be fewer than maxDataPoints
    */
    const granularityEntry = _.find(this.GRANULARITIES, gEntry => {
      return Math.ceil(intervalSecs / gEntry[1].asSeconds()) <= maxDataPoints;
    });

    return granularityEntry[0];
  }

  roundUpStartTime(from, granularity) {
    const duration = _.find(this.GRANULARITIES, gEntry => {
      return gEntry[0] === granularity;
    })[1];
    let rounded = null;
    if (granularity === 'day') {
      rounded = moment(+from).startOf('day');
    } else {
      rounded = moment(Math.ceil((+from) / (+duration)) * (+duration));
    }
    return rounded;
  }

  replaceTemplateValues(obj, attrList, panelId) {
    if (_.isArray(obj)) {
      return obj.map(e => this.replaceTemplateValues(e, attrList, panelId));
    } else {
      const substitutedVals = attrList.map(attr => {
        if (_.isArray(obj[attr])) {
          return obj[attr].map(e => this.replaceTemplateValues(e, attrList, panelId));
        } else {
          return this.templateSrv.replace(obj[attr], this.scopedVars[panelId]);
        }
      });
      return _.assign(_.clone(obj, true), _.zipObject(attrList, substitutedVals));
    }
  }

  replaceTemplateValuesNum(val, panelId) {
    return (typeof val === 'string')
        ? this.templateSrv.replace(val, this.scopedVars[panelId])
        : val;
  }
}
