System.register(["lodash", "moment", "app/core/utils/datemath", "angular"], function (exports_1, context_1) {
    "use strict";
    var lodash_1, moment_1, dateMath, angular_1, DRUID_DATASOURCE_PATH, DruidDatasource;
    var __moduleName = context_1 && context_1.id;
    return {
        setters: [
            function (lodash_1_1) {
                lodash_1 = lodash_1_1;
            },
            function (moment_1_1) {
                moment_1 = moment_1_1;
            },
            function (dateMath_1) {
                dateMath = dateMath_1;
            },
            function (angular_1_1) {
                angular_1 = angular_1_1;
            }
        ],
        execute: function () {
            DRUID_DATASOURCE_PATH = '/druid/v2/datasources';
            DruidDatasource = (function () {
                function DruidDatasource(instanceSettings, $q, backendSrv, templateSrv) {
                    this.GRANULARITIES = [
                        ['second', moment_1.default.duration(1, 'second')],
                        ['minute', moment_1.default.duration(1, 'minute')],
                        ['fifteen_minute', moment_1.default.duration(15, 'minute')],
                        ['thirty_minute', moment_1.default.duration(30, 'minute')],
                        ['hour', moment_1.default.duration(1, 'hour')],
                        ['day', moment_1.default.duration(1, 'day')],
                        ['week', moment_1.default.duration(1, 'week')],
                        ['month', moment_1.default.duration(1, 'month')],
                        ['quarter', moment_1.default.duration(1, 'quarter')],
                        ['year', moment_1.default.duration(1, 'year')]
                    ];
                    this.filterTemplateExpanders = {
                        "selector": ['value'],
                        "array": ['value'],
                        "regex": ['pattern'],
                        "javascript": ['function'],
                        "search": []
                    };
                    this.scopedVars = {};
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
                DruidDatasource.prototype.query = function (options) {
                    var _this = this;
                    var from = this.dateToMoment(options.range.from, false);
                    var to = this.dateToMoment(options.range.to, true);
                    this.scopedVars[options.panelId] = options.scopedVars;
                    var promises = options.targets.map(function (target) {
                        if (target.hide === true || lodash_1.default.isEmpty(target.druidDS) || (lodash_1.default.isEmpty(target.aggregators) && target.queryType !== "select")) {
                            var d = _this.q.defer();
                            d.resolve([]);
                            return d.promise;
                        }
                        var maxDataPointsByResolution = options.maxDataPoints;
                        var maxDataPointsByConfig = target.maxDataPoints ? target.maxDataPoints : Number.MAX_VALUE;
                        var maxDataPoints = Math.min(maxDataPointsByResolution, maxDataPointsByConfig);
                        var customGranularity = _this.templateSrv.replace(target.customGranularity, _this.scopedVars[options.panelId]);
                        var shouldOverrideGranularity = target.shouldOverrideGranularity && (customGranularity !== 'auto');
                        var granularity = shouldOverrideGranularity ? customGranularity : _this.computeGranularity(from, to, maxDataPoints);
                        var roundedFrom = granularity === "all" ? from : _this.roundUpStartTime(from, granularity);
                        if (_this.periodGranularity != "") {
                            if (granularity === 'day') {
                                granularity = { "type": "period", "period": "P1D", "timeZone": _this.periodGranularity };
                            }
                        }
                        return _this.doQuery(roundedFrom, to, granularity, target, options.panelId)
                            .then(function (response) {
                            _this.applyMultiplier(target.aggregators, ['longSum', 'doubleSum'], response, options.panelId);
                            _this.applyMultiplier(target.postAggregators, ['fieldAccess', 'arithmetic'], response, options.panelId);
                            return response;
                        });
                    });
                    return this.q.all(promises).then(function (results) {
                        return { data: lodash_1.default.flatten(results) };
                    });
                };
                DruidDatasource.prototype.applyMultiplier = function (aggregator, types, data, panelId) {
                    var _this = this;
                    if (!aggregator)
                        return;
                    aggregator.filter(function (a) { return lodash_1.default.includes(types, a.type) && a.extMultiplier; })
                        .forEach(function (a) {
                        var name = _this.replaceTemplateValuesNum(a.name, panelId), extMultiplier = _this.replaceTemplateValuesNum(a.extMultiplier, panelId);
                        data.filter(function (r) { return r.target === name; })
                            .flatMap(function (r) { return r.datapoints; })
                            .forEach(function (dp) { return dp[0] = dp[0] * extMultiplier; });
                        data.filter(function (set) { return set.columns && set.rows && set.columns.find(function (v) { return v.text === name; }); })
                            .forEach(function (set) {
                            var i = set.columns.findIndex(function (v) { return v.text === name; });
                            set.rows.forEach(function (r) { return r[i] *= _this.replaceTemplateValuesNum(extMultiplier, panelId); });
                        });
                    });
                };
                DruidDatasource.prototype.doQuery = function (from, to, granularity, target, panelId) {
                    var _this = this;
                    var datasource = target.druidDS;
                    var filters = target.filters;
                    var aggregators = this.replaceTemplateValues(target.aggregators, ['name', 'fieldName', 'fields'], panelId).map(this.splitArrayFields);
                    var postAggregators = target.postAggregators
                        ? this.replaceTemplateValues(target.postAggregators, ['name', 'fieldName', 'fields'], panelId).map(this.splitArrayFields)
                        : [];
                    var groupBy = lodash_1.default.map(target.groupBy, function (e) { return _this.templateSrv.replace(e, _this.scopedVars[panelId]); });
                    var limitSpec = null;
                    var metricNames = this.getMetricNames(aggregators, postAggregators);
                    var intervals = this.getQueryIntervals(from, to);
                    var promise = null;
                    var selectMetrics = target.selectMetrics;
                    var selectDimensions = target.selectDimensions;
                    var selectThreshold = target.selectThreshold;
                    if (!selectThreshold) {
                        selectThreshold = 5;
                    }
                    if (target.queryType === 'topN') {
                        var threshold = this.replaceTemplateValuesNum(target.limit, panelId);
                        var metric_1 = this.templateSrv.replace(target.druidMetric, this.scopedVars[panelId]);
                        var metricToShow_1 = this.templateSrv.replace(target.druidMetricToShow, this.scopedVars[panelId]);
                        var dimension_1 = this.templateSrv.replace(target.dimension, this.scopedVars[panelId]);
                        promise = this.topNQuery(datasource, intervals, granularity, filters, aggregators, postAggregators, threshold, metric_1, dimension_1, panelId)
                            .then(function (response) {
                            return _this.convertTopNData(response.data, dimension_1, metricToShow_1 ? metricToShow_1 : metric_1);
                        });
                    }
                    else if (target.queryType === 'groupBy') {
                        var order = (typeof target.orderBy === 'string')
                            ? this.templateSrv.replace(target.orderBy, this.scopedVars[panelId]).split(',')
                            : target.orderBy;
                        limitSpec = this.getLimitSpec(this.replaceTemplateValuesNum(target.limit, panelId), order, panelId);
                        promise = this.groupByQuery(datasource, intervals, granularity, filters, aggregators, postAggregators, groupBy, limitSpec, panelId)
                            .then(function (response) {
                            return target.tableType === 'table'
                                ? _this.convertGroupByDataAsTable(response.data, groupBy, metricNames)
                                : _this.convertGroupByData(response.data, groupBy, metricNames);
                        });
                    }
                    else if (target.queryType === 'select') {
                        promise = this.selectQuery(datasource, intervals, granularity, selectDimensions, selectMetrics, filters, selectThreshold, panelId);
                        return promise.then(function (response) {
                            return _this.convertSelectData(response.data);
                        });
                    }
                    else {
                        promise = this.timeSeriesQuery(datasource, intervals, granularity, filters, aggregators, postAggregators, panelId)
                            .then(function (response) {
                            return _this.convertTimeSeriesData(response.data, metricNames);
                        });
                    }
                    return promise.then(function (metrics) {
                        var fromMs = _this.formatTimestamp(from);
                        metrics.forEach(function (metric) {
                            if (metric.datapoints && !lodash_1.default.isEmpty(metric.datapoints[0]) && metric.datapoints[0][1] < fromMs) {
                                metric.datapoints[0][1] = fromMs;
                            }
                        });
                        return metrics;
                    });
                };
                ;
                DruidDatasource.prototype.splitArrayFields = function (aggregator) {
                    if ((aggregator.type === 'cardinality' || aggregator.type === 'javascript') &&
                        typeof aggregator.fieldNames === 'string') {
                        aggregator.fieldNames = aggregator.fieldNames.split(',');
                    }
                    return aggregator;
                };
                DruidDatasource.prototype.selectQuery = function (datasource, intervals, granularity, dimensions, metric, filters, selectThreshold, panelId) {
                    var query = {
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
                ;
                DruidDatasource.prototype.timeSeriesQuery = function (datasource, intervals, granularity, filters, aggregators, postAggregators, panelId) {
                    var query = {
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
                ;
                DruidDatasource.prototype.topNQuery = function (datasource, intervals, granularity, filters, aggregators, postAggregators, threshold, metric, dimension, panelId) {
                    var query = {
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
                ;
                DruidDatasource.prototype.groupByQuery = function (datasource, intervals, granularity, filters, aggregators, postAggregators, groupBy, limitSpec, panelId) {
                    var query = {
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
                ;
                DruidDatasource.prototype.druidQuery = function (query) {
                    var options = {
                        method: 'POST',
                        url: this.url + '/druid/v2/',
                        data: query
                    };
                    return this.backendSrv.datasourceRequest(options);
                };
                ;
                DruidDatasource.prototype.getLimitSpec = function (limitNum, orderBy, panelId) {
                    var _this = this;
                    return {
                        "type": "default",
                        "limit": limitNum,
                        "columns": !orderBy ? null : orderBy.map(function (col) {
                            var columnName = _this.templateSrv.replace(col, _this.scopedVars[panelId]);
                            if (columnName.startsWith('!')) {
                                return {
                                    "dimension": columnName.substr(1),
                                    "direction": "ASCENDING"
                                };
                            }
                            else {
                                return {
                                    "dimension": columnName,
                                    "direction": "DESCENDING"
                                };
                            }
                        })
                    };
                };
                DruidDatasource.prototype.metricFindQuery = function (query) {
                    var range = angular_1.default.element('grafana-app').injector().get('timeSrv').timeRangeForUrl(), from = this.dateToMoment(range.from, false), to = this.dateToMoment(range.to, true), intervals = this.getQueryIntervals(from, to);
                    var q = JSON.parse(this.templateSrv.replace(query));
                    if (lodash_1.default.isArray(q.filters))
                        q.filter = this.buildFilterTree(q.filters.filter(function (f) { return !f.value || f.value !== 'skipFilter'; }), undefined);
                    if (q.filter && q.filter.fields)
                        q.filter.fields = q.filter.fields.filter(function (f) { return !f.value || f.value !== 'skipFilter'; });
                    q.intervals = intervals;
                    return this.druidQuery(q)
                        .then(function (response) {
                        return lodash_1.default.map(response.data[0].result, function (e) {
                            return { "text": e[q.dimension] };
                        });
                    });
                };
                DruidDatasource.prototype.testDatasource = function () {
                    return this.get(DRUID_DATASOURCE_PATH).then(function () {
                        return { status: "success", message: "Druid Data source is working", title: "Success" };
                    });
                };
                DruidDatasource.prototype.getDataSources = function () {
                    return this.get(DRUID_DATASOURCE_PATH).then(function (response) {
                        return response.data;
                    });
                };
                ;
                DruidDatasource.prototype.getDimensionsAndMetrics = function (datasource) {
                    return this.get(DRUID_DATASOURCE_PATH + '/' + datasource).then(function (response) {
                        return response.data;
                    });
                };
                ;
                DruidDatasource.prototype.getFilterValues = function (target, panelRange, query, panelId) {
                    var topNquery = {
                        "queryType": "topN",
                        "dataSource": target.druidDS,
                        "granularity": 'all',
                        "threshold": 10,
                        "dimension": target.currentFilter.dimension,
                        "metric": "count",
                        "aggregations": [{ "type": "count", "name": "count" }],
                        "intervals": this.getQueryIntervals(panelRange.from, panelRange.to)
                    };
                    var filters = [];
                    if (target.filters) {
                        filters =
                            filters = lodash_1.default.cloneDeep(target.filters);
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
                ;
                DruidDatasource.prototype.get = function (relativeUrl, params) {
                    return this.backendSrv.datasourceRequest({
                        method: 'GET',
                        url: this.url + relativeUrl,
                        params: params,
                    });
                };
                ;
                DruidDatasource.prototype.buildFilterTree = function (filters, panelId) {
                    var _this = this;
                    var replacedFilters = filters
                        .map(function (filter) {
                        return _this.replaceTemplateValues(filter, _this.filterTemplateExpanders[filter.type], panelId);
                    })
                        .filter(function (f) { return f[_this.filterTemplateExpanders[f.type]]; })
                        .map(function (f) {
                        f.dimension = _this.templateSrv.replace(f.dimension, _this.scopedVars[panelId]);
                        if (f.type !== 'array')
                            return f;
                        if (f.value.startsWith('skipFilter'))
                            return undefined;
                        var negate = f.value.startsWith('!') || f.negate;
                        if (f.value.startsWith('!'))
                            f.value = f.value.substr(1);
                        return {
                            'type': 'or',
                            'negate': negate,
                            'fields': f.value.split(',').map(function (value) {
                                var copy = lodash_1.default.omit(f, 'negate');
                                copy.value = value;
                                copy.type = 'selector';
                                return copy;
                            })
                        };
                    })
                        .filter(function (f) { return f; })
                        .map(function (filter) {
                        var finalFilter = lodash_1.default.omit(filter, 'negate');
                        if (filter.negate) {
                            return { "type": "not", "field": finalFilter };
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
                };
                DruidDatasource.prototype.getQueryIntervals = function (from, to) {
                    return [from.toISOString() + '/' + to.toISOString()];
                };
                DruidDatasource.prototype.getMetricNames = function (aggregators, postAggregators) {
                    var displayAggs = lodash_1.default.filter(aggregators, function (agg) {
                        return agg.type !== 'approxHistogramFold' && agg.hidden != true;
                    });
                    return lodash_1.default.union(lodash_1.default.map(displayAggs, 'name'), lodash_1.default.map(postAggregators, 'name'));
                };
                DruidDatasource.prototype.formatTimestamp = function (ts) {
                    return moment_1.default(ts).format('X') * 1000;
                };
                DruidDatasource.prototype.convertTimeSeriesData = function (md, metrics) {
                    var _this = this;
                    return metrics.map(function (metric) {
                        return {
                            target: metric,
                            datapoints: md.map(function (item) {
                                return [
                                    item.result[metric],
                                    _this.formatTimestamp(item.timestamp)
                                ];
                            })
                        };
                    });
                };
                DruidDatasource.prototype.getGroupName = function (groupBy, metric) {
                    return groupBy.map(function (dim) {
                        return metric.event[dim];
                    })
                        .join("-");
                };
                DruidDatasource.prototype.convertTopNData = function (md, dimension, metric) {
                    var _this = this;
                    var dVals = md.reduce(function (dValsSoFar, tsItem) {
                        var dValsForTs = lodash_1.default.map(tsItem.result, dimension);
                        return lodash_1.default.union(dValsSoFar, dValsForTs);
                    }, {});
                    md.forEach(function (tsItem) {
                        var dValsPresent = lodash_1.default.map(tsItem.result, dimension);
                        var dValsMissing = lodash_1.default.difference(dVals, dValsPresent);
                        dValsMissing.forEach(function (dVal) {
                            var nullPoint = {};
                            nullPoint[dimension] = dVal;
                            nullPoint[metric] = null;
                            tsItem.result.push(nullPoint);
                        });
                        return tsItem;
                    });
                    var mergedData = md.map(function (item) {
                        var timestamp = _this.formatTimestamp(item.timestamp);
                        var keys = lodash_1.default.map(item.result, dimension);
                        var vals = lodash_1.default.map(item.result, metric).map(function (val) { return [val, timestamp]; });
                        return lodash_1.default.zipObject(keys, vals);
                    })
                        .reduce(function (prev, curr) {
                        return lodash_1.default.assignWith(prev, curr, function (pVal, cVal) {
                            if (pVal) {
                                pVal.push(cVal);
                                return pVal;
                            }
                            return [cVal];
                        });
                    }, {});
                    return lodash_1.default.map(mergedData, function (vals, key) {
                        return {
                            target: key,
                            datapoints: vals
                        };
                    });
                };
                DruidDatasource.prototype.convertGroupByDataAsTable = function (md, groupBy, metrics) {
                    var res = {};
                    res.type = 'table';
                    res.columns = metrics.reduce(function (a, v) {
                        a.push({ text: v });
                        return a;
                    }, groupBy.reduce(function (a, v) {
                        a.push({ text: v });
                        return a;
                    }, []));
                    res.rows = md.reduce(function (a, d) {
                        a.push(res.columns.reduce(function (aa, m) {
                            aa.push(d.event[m.text]);
                            return aa;
                        }, []));
                        return a;
                    }, []);
                    res.meta = { rowCount: md.length };
                    return [res];
                };
                DruidDatasource.prototype.convertGroupByData = function (md, groupBy, metrics) {
                    var _this = this;
                    var mergedData = md.map(function (item) {
                        var groupName = _this.getGroupName(groupBy, item);
                        var keys = metrics.map(function (metric) {
                            return groupName + ":" + metric;
                        });
                        var vals = metrics.map(function (metric) {
                            return [
                                item.event[metric],
                                _this.formatTimestamp(item.timestamp)
                            ];
                        });
                        return lodash_1.default.zipObject(keys, vals);
                    })
                        .reduce(function (prev, curr) {
                        return lodash_1.default.assignWith(prev, curr, function (pVal, cVal) {
                            if (pVal) {
                                pVal.push(cVal);
                                return pVal;
                            }
                            return [cVal];
                        });
                    }, {});
                    return lodash_1.default.map(mergedData, function (vals, key) {
                        return {
                            target: key,
                            datapoints: vals
                        };
                    });
                };
                DruidDatasource.prototype.convertSelectData = function (data) {
                    var resultList = lodash_1.default.map(data, "result");
                    var eventsList = lodash_1.default.map(resultList, "events");
                    var eventList = lodash_1.default.flatten(eventsList);
                    var result = {};
                    for (var i = 0; i < eventList.length; i++) {
                        var event_1 = eventList[i].event;
                        var timestamp = event_1.timestamp;
                        if (lodash_1.default.isEmpty(timestamp)) {
                            continue;
                        }
                        for (var key in event_1) {
                            if (key !== "timestamp") {
                                if (!result[key]) {
                                    result[key] = { "target": key, "datapoints": [] };
                                }
                                result[key].datapoints.push([event_1[key], timestamp]);
                            }
                        }
                    }
                    return lodash_1.default.values(result);
                };
                DruidDatasource.prototype.dateToMoment = function (date, roundUp) {
                    if (date === 'now') {
                        return moment_1.default();
                    }
                    date = dateMath.parse(date, roundUp);
                    return moment_1.default(date.valueOf());
                };
                DruidDatasource.prototype.computeGranularity = function (from, to, maxDataPoints) {
                    var intervalSecs = to.unix() - from.unix();
                    var granularityEntry = lodash_1.default.find(this.GRANULARITIES, function (gEntry) {
                        return Math.ceil(intervalSecs / gEntry[1].asSeconds()) <= maxDataPoints;
                    });
                    return granularityEntry[0];
                };
                DruidDatasource.prototype.roundUpStartTime = function (from, granularity) {
                    var duration = lodash_1.default.find(this.GRANULARITIES, function (gEntry) {
                        return gEntry[0] === granularity;
                    })[1];
                    var rounded = null;
                    if (granularity === 'day') {
                        rounded = moment_1.default(+from).startOf('day');
                    }
                    else {
                        rounded = moment_1.default(Math.ceil((+from) / (+duration)) * (+duration));
                    }
                    return rounded;
                };
                DruidDatasource.prototype.replaceTemplateValues = function (obj, attrList, panelId) {
                    var _this = this;
                    if (lodash_1.default.isArray(obj)) {
                        return obj.map(function (e) { return _this.replaceTemplateValues(e, attrList, panelId); });
                    }
                    else {
                        var substitutedVals = attrList.map(function (attr) {
                            if (lodash_1.default.isArray(obj[attr])) {
                                return obj[attr].map(function (e) { return _this.replaceTemplateValues(e, attrList, panelId); });
                            }
                            else {
                                return _this.templateSrv.replace(obj[attr], _this.scopedVars[panelId]);
                            }
                        });
                        return lodash_1.default.assign(lodash_1.default.clone(obj, true), lodash_1.default.zipObject(attrList, substitutedVals));
                    }
                };
                DruidDatasource.prototype.replaceTemplateValuesNum = function (val, panelId) {
                    return (typeof val === 'string')
                        ? this.templateSrv.replace(val, this.scopedVars[panelId])
                        : val;
                };
                return DruidDatasource;
            }());
            exports_1("default", DruidDatasource);
        }
    };
});
//# sourceMappingURL=datasource.js.map