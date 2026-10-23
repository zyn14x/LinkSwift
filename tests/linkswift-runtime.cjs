/* global __dirname, process, setTimeout, URL, URLSearchParams, structuredClone */
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function typeOf(value) {
	if (value === null) return "null";
	if (Array.isArray(value)) return "array";
	return typeof value;
}

function methodSource(source, provider, method) {
	const providerStart = source.indexOf(`const $${provider} = {`);
	const methodStart = source.indexOf(`\t\tasync ${method}(`, providerStart);
	const methodEnd = source.indexOf("\n\t\t},", methodStart);
	if (providerStart < 0 || methodStart < 0 || methodEnd < 0) {
		throw new Error(`Cannot find ${provider}.${method}`);
	}
	// Include the method's closing brace, but not the separator comma.
	return source.slice(methodStart, methodEnd + 4);
}

module.exports = function createRuntime(provider, methods) {
	const filename = process.env.LINKSWIFT_SOURCE ||
		path.join(__dirname, "..", "（改）网盘直链下载助手.user.js");
	const source = fs.readFileSync(filename, "utf8").replace(/\r\n/g, "\n");
	const configStart = source.indexOf("\tconst config = {");
	const configEnd = source.indexOf("\n\t/**\n\t * 百度网盘", configStart);
	if (configStart < 0 || configEnd < configStart) {
		throw new Error("Cannot find the userscript configuration");
	}

	const progress = [];
	const sleeps = [];
	const deleted = [];
	const transport = {
		get: async () => { throw new Error("Unexpected GET request"); },
		post: async () => { throw new Error("Unexpected POST request"); }
	};
	const context = vm.createContext({
		URL,
		URLSearchParams,
		structuredClone,
		setTimeout,
		__transport: transport,
		__sleeps: sleeps,
		__deleted: deleted,
		navigator: { userAgent: "LinkSwift regression test" },
		location: { origin: "https://example.test", host: "example.test" },
		temp: { glinks: [] },
		$doc: {
			find: selector => ({
				html: value => progress.push({ selector, value })
			})
		},
		base: {
			isType: typeOf,
			clone: value => structuredClone(value),
			sleep: async milliseconds => sleeps.push(milliseconds),
			delValue: key => deleted.push(key),
			encodeBase: value => String(value),
			get: (...args) => transport.get(...args),
			post: (...args) => transport.post(...args)
		}
	});

	vm.runInContext(`${source.slice(configStart, configEnd)}\nglobalThis.config = config;`, context);
	vm.runInContext(`
		base.get = (...args) => __transport.get(...args);
		base.post = (...args) => __transport.post(...args);
		base.sleep = async milliseconds => __sleeps.push(milliseconds);
		base.delValue = key => __deleted.push(key);
	`, context);

	const api = {};
	for (const method of methods) {
		api[method] = vm.runInContext(`({${methodSource(source, provider, method)}})`, context)[method];
	}

	return {
		api,
		temp: context.temp,
		progress,
		sleeps,
		deleted,
		setGet(handler) {
			transport.get = handler;
		},
		setPost(handler) {
			transport.post = handler;
		}
	};
};
