
var _ = require('underscore');
var util = require('util');
var dandy = require('dandy/errors');
var url = require('url');
var assert = require('assert').ok;

var jsonMimeType = 'application/x-javascript; charset=UTF-8';
var reFunc = /function\s+\((.*?)\)/
var debugMode = process.env.NODE_ENV != 'production';

// *************************************************************************************************

function API(apiPath) {
	this.apiPath = apiPath[apiPath.length-1] == '/' ? apiPath.substr(0, apiPath.length-1) : apiPath;
}

API.prototype = {
	route: function(server) {
		return _.bind(function(req, res) {
			var URL = url.parse(req.url);
			this.lookup(req.method, URL.pathname, _.bind(function(err, found) {
				if (err) {
					sendError(req, res, err, err ? err.error : 0);
				} else {
					var q = req.query;
					if (req.body) {
						_.extend(q, req.body);
					}
					this.invoke(found.methodDef, found.params, req.headers, q, req.params, req.cookies,
					_.bind(function(err, result) {
						if (err) {
							sendError(req, res, err, err ? err.error : 0);
						} else {
							var finalResult;
							if (typeof(result) == "object") {
								if (result.cookies) {
									result.cookies.forEach(function(params) {
										res.cookie.apply(res, params);
									});
								}
								if (result.doNotCache) {
									res.doNotCache = true;
								}
								if (typeof(result.body) == "object") {
									finalResult = _.clone(result);
									finalResult.body = JSON.stringify(finalResult.body);
								} else {
									finalResult = result;
								}
							} else {
								finalResult = {body: result};
							}

							sendPage(req, res, finalResult);
						}
					}, this));
				}
			}, this));
		}, this);
	},

	call: function(method, pathname, headers, query, params, cookies, cb) {
		this.lookup(method, pathname, _.bind(function(err, found) {
			if (err) {
				cb(err);
			} else {
				this.invoke(found.methodDef, found.params, headers, query, params, cookies, cb);
			}
		}, this));
	},

	lookup: function(method, pathname, cb) {
		var apiPathIndex = pathname ? pathname.indexOf(this.apiPath) : -1;
		if (apiPathIndex == -1) {
			cb({error: 404, description: 'Not an API call.'});
			return;			
		}

		pathname = pathname.substr(apiPathIndex+this.apiPath.length+1);
		var parts = pathname.split('/');
		if (parts.length < 1) {
			cb({error: 404, description: "Function name required."}); return;
		}

		var functionName = parts[0];
		var urlParams = parts.slice(1);

		var funcDef = this.definitions[functionName];
		if (!funcDef) {
			cb({error: 404,
				description: 'Function "' + functionName + '" not found.'});
			return;
		}

		var methodDef = funcDef[method.toUpperCase()];
		if (!methodDef) {
			cb({error: 500,
				description: 'Function "' + functionName + '" has no ' + method + ' method'});
			return;
		}	

		this._compileMethod(methodDef);

		cb(0, {name: functionName, params: urlParams, methodDef: methodDef});
	},

	invoke: function(methodDef, urlParams, headers, query, params, cookies, cb) {
		var args = [];

		if (methodDef.argCount) {
			// Fill in undefined for all unspecified URL arguments
			if (urlParams.length < methodDef.argCount) {
				urlParams[methodDef.argCount-1] = undefined;
			}

			// Insert the maximum number of URL arguments in the function arguments
			var subset = urlParams.slice(0, methodDef.argCount);
			args.push.apply(args, subset);
		}

		if (methodDef.headersIndex != -1) {
			args[methodDef.headersIndex] = headers;
		}
		if (methodDef.paramsIndex != -1) {
			args[methodDef.paramsIndex] = params;
		}
		if (methodDef.queryIndex != -1) {
			args[methodDef.queryIndex] = query;
		}
		if (methodDef.cookiesIndex != -1) {
			args[methodDef.cookiesIndex] = cookies;
		}

		args.push(cb);

		methodDef.fn.apply(this, args);
	},

	_compileMethod: function(methodDef) {
		if (methodDef.compiled) return;

		var js = methodDef.fn+'';
		var m = reFunc.exec(js);
		var args = m[1].split(/\s*,\s*/);

		var headersIndex = methodDef.headersIndex = args.lastIndexOf('headers'); 
		var paramsIndex = methodDef.paramsIndex = args.lastIndexOf('params');
		var queryIndex = methodDef.queryIndex = args.lastIndexOf('query');
		var cookiesIndex = methodDef.cookiesIndex = args.lastIndexOf('cookies');

		var lastMetaIndex = Number.MAX_VALUE;
		if (headersIndex != -1 && headersIndex < lastMetaIndex) {
			lastMetaIndex = headersIndex;
		}
		if (queryIndex != -1 && queryIndex < lastMetaIndex) {
			lastMetaIndex = queryIndex;
		}
		if (paramsIndex != -1 && paramsIndex < lastMetaIndex) {
			lastMetaIndex = paramsIndex;
		}
		if (cookiesIndex != -1 && cookiesIndex < lastMetaIndex) {
			lastMetaIndex = cookiesIndex;
		}

		if (lastMetaIndex == Number.MAX_VALUE) {
			methodDef.argCount = args.length-1;
		} else if (lastMetaIndex == 0) {
			methodDef.argCount = 0;
		} else {
			methodDef.argCount = lastMetaIndex;
		}

		methodDef.compiled = true;
	}
}

API.statics = {
	define: function(method, name, docs, fn) {
		if (typeof(docs) == "function") {
			fn = docs;
			docs = null;
		}

		var proto = this.prototype;
		if (!proto.definitions) {
			proto.definitions = {};
		}
		if (!proto.definitions[name]) {
			proto.definitions[name] = {};
		}

		var def = proto.definitions[name];
		def[method.toUpperCase()] = {docs: docs, fn: fn};

		this.prototype[name] = fn;
	},

	GET: function(name, docs, fn) {
		return this.define("GET", name, docs, fn);
	},

	POST: function(name, docs, fn) {
		return this.define("POST", name, docs, fn);
	},

	PUT: function(name, docs, fn) {
		return this.define("PUT", name, docs, fn);
	},

	DELETE: function(name, docs, fn) {
		return this.define("DELETE", name, docs, fn);
	},
}

exports.API = function(constructor, proto) {
	if (typeof(constructor) != "function") {
		proto = constructor;
		constructor = null;
	}

	var cls = constructor || function() {};

    cls.super_ = API;
    cls.prototype = Object.create(API.prototype, {
        constructor: {value: cls, enumerable: false}
    });
    _.extend(cls.prototype, proto);
    _.extend(cls, API.statics);
    return cls;
}

// *************************************************************************************************

function sendPage(req, res, result) {
    res.header('Content-Type', jsonMimeType);

    if (result.etag) {
        res.header('ETag', result.etag);
    }

    if (result.cacheControl) {
        res.header('Cache-Control', result.cacheControl);
    }

    var body = result.body;
    body = (req.query.callback || '') + '(' + body + ')';

    res.send(body, 200);
}

function sendError(req, res, err, code) {
    if (err) {
        dandy.logException(err,
            "Error while loading " + req.url + "\n" + util.inspect(req.headers));
    }

    var body = debugMode 
    	? JSON.stringify({error: code, description: (err && err.description || err)+'', stack: err.stack})
    	: JSON.stringify({error: code});
    if (req.query.callback) {
        // JSONP must return 200 status in order for JSON body to be received by client
        code = 200;
        body = req.query.callback + '(' + body + ')';
        res.doNotCache = true;
    }    

    res.send(body, {'Content-Type': jsonMimeType}, code || 500);
}
