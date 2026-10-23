/* global setImmediate */
const assert = require("node:assert/strict");
const { test } = require("node:test");
const createRuntime = require("./linkswift-runtime.cjs");

const baiduFiles = count => Array.from({ length: count }, (_, index) => ({
	fs_id: index + 1,
	isdir: 0,
	name: `file-${index + 1}`
}));

test("百度批量失败时逐项隔离，保留可获取的文件", async () => {
	const ctx = createRuntime("baidu", ["getFilesUrl"]);
	const requests = [];
	ctx.setGet(async url => {
		const ids = JSON.parse(url.searchParams.get("fsids"));
		requests.push(ids);
		if (ids.length > 1) return { errno: -6, errmsg: "batch rejected" };
		if (ids[0] === 1) return { errno: 0, list: [{ fs_id: 1, dlink: "https://example.test/1" }] };
		return { errno: -7, errmsg: "file rejected" };
	});

	const result = await ctx.api.getFilesUrl(baiduFiles(2), "fixture-token");

	assert.deepEqual(requests, [[1, 2], [1], [2]]);
	assert.equal(result[0].dlink, "https://example.test/1");
	assert.match(result[1].dlink, /-7/);
	assert.deepEqual(ctx.temp.glinks.map(item => item.id), [1]);
	assert.equal(ctx.progress.at(-1).value, "已获取 2 / 2 个地址");
});

test("百度批量返回业务错误后仍处理后续批次", async () => {
	const ctx = createRuntime("baidu", ["getFilesUrl"]);
	ctx.setGet(async url => {
		const ids = JSON.parse(url.searchParams.get("fsids"));
		if (ids.length === 1 && ids[0] <= 50) return { errno: -7, errmsg: "file rejected" };
		if (ids[0] === 1) return { errno: -6, errmsg: "batch rejected" };
		return { errno: 0, list: ids.map(fs_id => ({ fs_id, dlink: `https://example.test/${fs_id}` })) };
	});

	const result = await ctx.api.getFilesUrl(baiduFiles(51), "fixture-token");

	assert.equal(result.slice(0, 50).every(item => /batch rejected|file rejected/.test(item.dlink)), true);
	assert.equal(result[50].dlink, "https://example.test/51");
	assert.deepEqual(ctx.temp.glinks.map(item => item.id), [51]);
	assert.equal(ctx.progress.at(-1).value, "已获取 51 / 51 个地址");
});

test("百度失败项不缓存，成功项可命中缓存", async () => {
	const ctx = createRuntime("baidu", ["getFilesUrl"]);
	ctx.setGet(async () => ({
		errno: 0,
		list: [
			{ fs_id: 1, dlink: "https://example.test/1" },
			null
		]
	}));

	const first = await ctx.api.getFilesUrl(baiduFiles(2), "fixture-token");
	assert.equal(first[0].dlink, "https://example.test/1");
	assert.match(first[1].dlink, /未返回此文件/);
	assert.deepEqual(ctx.temp.glinks.map(item => item.id), [1]);

	ctx.setGet(async () => { throw new Error("valid cache must avoid a request"); });
	const second = await ctx.api.getFilesUrl(baiduFiles(1), "fixture-token");
	assert.equal(second[0].dlink, "https://example.test/1");
});

test("百度令牌失效立即停止，不进行逐项重试", async () => {
	const ctx = createRuntime("baidu", ["getFilesUrl"]);
	let requests = 0;
	ctx.setGet(async () => {
		requests++;
		return { errno: 9019, errmsg: "token expired" };
	});

	await assert.rejects(ctx.api.getFilesUrl(baiduFiles(2), "fixture-token"), /9019/);
	assert.equal(requests, 1);
	assert.deepEqual(ctx.deleted, ["baidu_access_token"]);
	assert.equal(ctx.temp.glinks.length, 0);
});

test("百度分享页大文件提示保存后下载，且不写入缓存", async () => {
	const ctx = createRuntime("baidu", ["getShareFilesUrl"]);
	let request = 0;
	ctx.setPost(async () => {
		request++;
		if (request === 1) return { errno: 0, list: "此文件过大，需要保存到网盘后于网盘中下载" };
		return { errno: 0, list: [{ fs_id: 2, dlink: "https://example.test/2" }] };
	});
	const shareData = {
		sign: "sign",
		timestamp: 1,
		baidu: { id: "log", token: "bdstoken" },
		jsToken: "js",
		share: { uk: "uk", id: "share" }
	};

	const result = await ctx.api.getShareFilesUrl(baiduFiles(2), shareData);

	assert.match(result[0].dlink, /受百度分享直链接口限制/);
	assert.match(result[0].dlink, /保存后下载/);
	assert.equal(result[1].dlink, "https://example.test/2");
	assert.deepEqual(ctx.temp.glinks.map(item => item.id), [2]);
	assert.equal(ctx.progress.at(-1).value, "已获取 2 / 2 个地址");
});

test("百度分享页错误项继续处理，且不缓存空结果", async () => {
	const ctx = createRuntime("baidu", ["getShareFilesUrl"]);
	let request = 0;
	ctx.setPost(async () => {
		request++;
		if (request === 1) return { errno: -9, errmsg: "file missing" };
		return { errno: 0, list: [{ fs_id: 2, dlink: "https://example.test/2" }] };
	});
	const shareData = {
		sign: "sign",
		timestamp: 1,
		baidu: { id: "log", token: "bdstoken" },
		jsToken: "js",
		share: { uk: "uk", id: "share" }
	};

	const result = await ctx.api.getShareFilesUrl(baiduFiles(2), shareData);

	assert.match(result[0].dlink, /-9 - file missing/);
	assert.equal(result[1].dlink, "https://example.test/2");
	assert.deepEqual(ctx.temp.glinks.map(item => item.id), [2]);
});

test("阿里云盘并发响应按文件隔离，失败项不影响成功项", async () => {
	const ctx = createRuntime("aliyun", ["getFilesUrl"]);
	const pending = [];
	ctx.setPost((_url, data) => new Promise(resolve => pending.push({ data, resolve })));
	const items = ["a", "b", "c"].map(fileId => ({
		fileId,
		driveId: "drive",
		type: "file",
		name: fileId
	}));

	const task = ctx.api.getFilesUrl(items, "fixture-token");
	assert.equal(pending.length, 3);
	for (const { data, resolve } of [...pending].reverse()) {
		if (data.file_id === "b") resolve({ code: "Forbidden" });
		else resolve({ url: `https://example.test/${data.file_id}` });
		await new Promise(setImmediate);
	}
	const result = await task;

	assert.equal(result[0].url, "https://example.test/a");
	assert.match(result[1].url, /Forbidden/);
	assert.equal(result[2].url, "https://example.test/c");
	assert.deepEqual(ctx.temp.glinks.map(item => item.id).sort(), ["a", "c"]);
});
/* global setImmediate */
const assert = require("node:assert/strict");
const { test } = require("node:test");
const createRuntime = require("./linkswift-runtime.cjs");

const baiduFiles = count => Array.from({ length: count }, (_, index) => ({
	fs_id: index + 1,
	isdir: 0,
	name: `file-${index + 1}`
}));

test("百度批量失败时逐项隔离，保留可获取的文件", async () => {
	const ctx = createRuntime("baidu", ["getFilesUrl"]);
	const requests = [];
	ctx.setGet(async url => {
		const ids = JSON.parse(url.searchParams.get("fsids"));
		requests.push(ids);
		if (ids.length > 1) return { errno: -6, errmsg: "batch rejected" };
		if (ids[0] === 1) return { errno: 0, list: [{ fs_id: 1, dlink: "https://example.test/1" }] };
		return { errno: -7, errmsg: "file rejected" };
	});

	const result = await ctx.api.getFilesUrl(baiduFiles(2), "fixture-token");

	assert.deepEqual(requests, [[1, 2], [1], [2]]);
	assert.equal(result[0].dlink, "https://example.test/1");
	assert.match(result[1].dlink, /-7/);
	assert.deepEqual(ctx.temp.glinks.map(item => item.id), [1]);
	assert.equal(ctx.progress.at(-1).value, "已获取 2 / 2 个地址");
});

test("百度批量返回业务错误后仍处理后续批次", async () => {
	const ctx = createRuntime("baidu", ["getFilesUrl"]);
	ctx.setGet(async url => {
		const ids = JSON.parse(url.searchParams.get("fsids"));
		if (ids.length === 1 && ids[0] <= 50) return { errno: -7, errmsg: "file rejected" };
		if (ids[0] === 1) return { errno: -6, errmsg: "batch rejected" };
		return { errno: 0, list: ids.map(fs_id => ({ fs_id, dlink: `https://example.test/${fs_id}` })) };
	});

	const result = await ctx.api.getFilesUrl(baiduFiles(51), "fixture-token");

	assert.equal(result.slice(0, 50).every(item => /batch rejected|file rejected/.test(item.dlink)), true);
	assert.equal(result[50].dlink, "https://example.test/51");
	assert.deepEqual(ctx.temp.glinks.map(item => item.id), [51]);
	assert.equal(ctx.progress.at(-1).value, "已获取 51 / 51 个地址");
});

test("百度失败项不缓存，成功项可命中缓存", async () => {
	const ctx = createRuntime("baidu", ["getFilesUrl"]);
	ctx.setGet(async () => ({
		errno: 0,
		list: [
			{ fs_id: 1, dlink: "https://example.test/1" },
			null
		]
	}));

	const first = await ctx.api.getFilesUrl(baiduFiles(2), "fixture-token");
	assert.equal(first[0].dlink, "https://example.test/1");
	assert.match(first[1].dlink, /未返回此文件/);
	assert.deepEqual(ctx.temp.glinks.map(item => item.id), [1]);

	ctx.setGet(async () => { throw new Error("valid cache must avoid a request"); });
	const second = await ctx.api.getFilesUrl(baiduFiles(1), "fixture-token");
	assert.equal(second[0].dlink, "https://example.test/1");
});

test("百度令牌失效立即停止，不进行逐项重试", async () => {
	const ctx = createRuntime("baidu", ["getFilesUrl"]);
	let requests = 0;
	ctx.setGet(async () => {
		requests++;
		return { errno: 9019, errmsg: "token expired" };
	});

	await assert.rejects(ctx.api.getFilesUrl(baiduFiles(2), "fixture-token"), /9019/);
	assert.equal(requests, 1);
	assert.deepEqual(ctx.deleted, ["baidu_access_token"]);
	assert.equal(ctx.temp.glinks.length, 0);
});

test("百度分享页大文件提示保存后下载，且不写入缓存", async () => {
	const ctx = createRuntime("baidu", ["getShareFilesUrl"]);
	let request = 0;
	ctx.setPost(async () => {
		request++;
		if (request === 1) return { errno: 0, list: "此文件过大，需要保存到网盘后于网盘中下载" };
		return { errno: 0, list: [{ fs_id: 2, dlink: "https://example.test/2" }] };
	});
	const shareData = {
		sign: "sign",
		timestamp: 1,
		baidu: { id: "log", token: "bdstoken" },
		jsToken: "js",
		share: { uk: "uk", id: "share" }
	};

	const result = await ctx.api.getShareFilesUrl(baiduFiles(2), shareData);

	assert.match(result[0].dlink, /受百度分享直链接口限制/);
	assert.match(result[0].dlink, /保存后下载/);
	assert.equal(result[1].dlink, "https://example.test/2");
	assert.deepEqual(ctx.temp.glinks.map(item => item.id), [2]);
	assert.equal(ctx.progress.at(-1).value, "已获取 2 / 2 个地址");
});

test("百度分享页错误项继续处理，且不缓存空结果", async () => {
	const ctx = createRuntime("baidu", ["getShareFilesUrl"]);
	let request = 0;
	ctx.setPost(async () => {
		request++;
		if (request === 1) return { errno: -9, errmsg: "file missing" };
		return { errno: 0, list: [{ fs_id: 2, dlink: "https://example.test/2" }] };
	});
	const shareData = {
		sign: "sign",
		timestamp: 1,
		baidu: { id: "log", token: "bdstoken" },
		jsToken: "js",
		share: { uk: "uk", id: "share" }
	};

	const result = await ctx.api.getShareFilesUrl(baiduFiles(2), shareData);

	assert.match(result[0].dlink, /-9 - file missing/);
	assert.equal(result[1].dlink, "https://example.test/2");
	assert.deepEqual(ctx.temp.glinks.map(item => item.id), [2]);
});

test("阿里云盘并发响应按文件隔离，失败项不影响成功项", async () => {
	const ctx = createRuntime("aliyun", ["getFilesUrl"]);
	const pending = [];
	ctx.setPost((_url, data) => new Promise(resolve => pending.push({ data, resolve })));
	const items = ["a", "b", "c"].map(fileId => ({
		fileId,
		driveId: "drive",
		type: "file",
		name: fileId
	}));

	const task = ctx.api.getFilesUrl(items, "fixture-token");
	assert.equal(pending.length, 3);
	for (const { data, resolve } of [...pending].reverse()) {
		if (data.file_id === "b") resolve({ code: "Forbidden" });
		else resolve({ url: `https://example.test/${data.file_id}` });
		await new Promise(setImmediate);
	}
	const result = await task;

	assert.equal(result[0].url, "https://example.test/a");
	assert.match(result[1].url, /Forbidden/);
	assert.equal(result[2].url, "https://example.test/c");
	assert.deepEqual(ctx.temp.glinks.map(item => item.id).sort(), ["a", "c"]);
});
/* global setImmediate */
const assert = require("node:assert/strict");
const { test } = require("node:test");
const createRuntime = require("./linkswift-runtime.cjs");

const baiduFiles = count => Array.from({ length: count }, (_, index) => ({
	fs_id: index + 1,
	isdir: 0,
	name: `file-${index + 1}`
}));

test("百度批量失败时逐项隔离，保留可获取的文件", async () => {
	const ctx = createRuntime("baidu", ["getFilesUrl"]);
	const requests = [];
	ctx.setGet(async url => {
		const ids = JSON.parse(url.searchParams.get("fsids"));
		requests.push(ids);
		if (ids.length > 1) return { errno: -6, errmsg: "batch rejected" };
		if (ids[0] === 1) return { errno: 0, list: [{ fs_id: 1, dlink: "https://example.test/1" }] };
		return { errno: -7, errmsg: "file rejected" };
	});

	const result = await ctx.api.getFilesUrl(baiduFiles(2), "fixture-token");

	assert.deepEqual(requests, [[1, 2], [1], [2]]);
	assert.equal(result[0].dlink, "https://example.test/1");
	assert.match(result[1].dlink, /-7/);
	assert.deepEqual(ctx.temp.glinks.map(item => item.id), [1]);
	assert.equal(ctx.progress.at(-1).value, "已获取 2 / 2 个地址");
});

test("百度批量返回业务错误后仍处理后续批次", async () => {
	const ctx = createRuntime("baidu", ["getFilesUrl"]);
	ctx.setGet(async url => {
		const ids = JSON.parse(url.searchParams.get("fsids"));
		if (ids.length === 1 && ids[0] <= 50) return { errno: -7, errmsg: "file rejected" };
		if (ids[0] === 1) return { errno: -6, errmsg: "batch rejected" };
		return { errno: 0, list: ids.map(fs_id => ({ fs_id, dlink: `https://example.test/${fs_id}` })) };
	});

	const result = await ctx.api.getFilesUrl(baiduFiles(51), "fixture-token");

	assert.equal(result.slice(0, 50).every(item => /batch rejected|file rejected/.test(item.dlink)), true);
	assert.equal(result[50].dlink, "https://example.test/51");
	assert.deepEqual(ctx.temp.glinks.map(item => item.id), [51]);
	assert.equal(ctx.progress.at(-1).value, "已获取 51 / 51 个地址");
});

test("百度失败项不缓存，成功项可命中缓存", async () => {
	const ctx = createRuntime("baidu", ["getFilesUrl"]);
	ctx.setGet(async () => ({
		errno: 0,
		list: [
			{ fs_id: 1, dlink: "https://example.test/1" },
			null
		]
	}));

	const first = await ctx.api.getFilesUrl(baiduFiles(2), "fixture-token");
	assert.equal(first[0].dlink, "https://example.test/1");
	assert.match(first[1].dlink, /未返回此文件/);
	assert.deepEqual(ctx.temp.glinks.map(item => item.id), [1]);

	ctx.setGet(async () => { throw new Error("valid cache must avoid a request"); });
	const second = await ctx.api.getFilesUrl(baiduFiles(1), "fixture-token");
	assert.equal(second[0].dlink, "https://example.test/1");
});

test("百度令牌失效立即停止，不进行逐项重试", async () => {
	const ctx = createRuntime("baidu", ["getFilesUrl"]);
	let requests = 0;
	ctx.setGet(async () => {
		requests++;
		return { errno: 9019, errmsg: "token expired" };
	});

	await assert.rejects(ctx.api.getFilesUrl(baiduFiles(2), "fixture-token"), /9019/);
	assert.equal(requests, 1);
	assert.deepEqual(ctx.deleted, ["baidu_access_token"]);
	assert.equal(ctx.temp.glinks.length, 0);
});

test("百度分享页大文件提示保存后下载，且不写入缓存", async () => {
	const ctx = createRuntime("baidu", ["getShareFilesUrl"]);
	let request = 0;
	ctx.setPost(async () => {
		request++;
		if (request === 1) return { errno: 0, list: "此文件过大，需要保存到网盘后于网盘中下载" };
		return { errno: 0, list: [{ fs_id: 2, dlink: "https://example.test/2" }] };
	});
	const shareData = {
		sign: "sign",
		timestamp: 1,
		baidu: { id: "log", token: "bdstoken" },
		jsToken: "js",
		share: { uk: "uk", id: "share" }
	};

	const result = await ctx.api.getShareFilesUrl(baiduFiles(2), shareData);

	assert.match(result[0].dlink, /受百度分享直链接口限制/);
	assert.match(result[0].dlink, /保存后下载/);
	assert.equal(result[1].dlink, "https://example.test/2");
	assert.deepEqual(ctx.temp.glinks.map(item => item.id), [2]);
	assert.equal(ctx.progress.at(-1).value, "已获取 2 / 2 个地址");
});

test("百度分享页错误项继续处理，且不缓存空结果", async () => {
	const ctx = createRuntime("baidu", ["getShareFilesUrl"]);
	let request = 0;
	ctx.setPost(async () => {
		request++;
		if (request === 1) return { errno: -9, errmsg: "file missing" };
		return { errno: 0, list: [{ fs_id: 2, dlink: "https://example.test/2" }] };
	});
	const shareData = {
		sign: "sign",
		timestamp: 1,
		baidu: { id: "log", token: "bdstoken" },
		jsToken: "js",
		share: { uk: "uk", id: "share" }
	};

	const result = await ctx.api.getShareFilesUrl(baiduFiles(2), shareData);

	assert.match(result[0].dlink, /-9 - file missing/);
	assert.equal(result[1].dlink, "https://example.test/2");
	assert.deepEqual(ctx.temp.glinks.map(item => item.id), [2]);
});

test("阿里云盘并发响应按文件隔离，失败项不影响成功项", async () => {
	const ctx = createRuntime("aliyun", ["getFilesUrl"]);
	const pending = [];
	ctx.setPost((_url, data) => new Promise(resolve => pending.push({ data, resolve })));
	const items = ["a", "b", "c"].map(fileId => ({
		fileId,
		driveId: "drive",
		type: "file",
		name: fileId
	}));

	const task = ctx.api.getFilesUrl(items, "fixture-token");
	assert.equal(pending.length, 3);
	for (const { data, resolve } of [...pending].reverse()) {
		if (data.file_id === "b") resolve({ code: "Forbidden" });
		else resolve({ url: `https://example.test/${data.file_id}` });
		await new Promise(setImmediate);
	}
	const result = await task;

	assert.equal(result[0].url, "https://example.test/a");
	assert.match(result[1].url, /Forbidden/);
	assert.equal(result[2].url, "https://example.test/c");
	assert.deepEqual(ctx.temp.glinks.map(item => item.id).sort(), ["a", "c"]);
});
