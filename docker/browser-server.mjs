import { createServer } from "node:http";
import { lstat, readFile, rename, writeFile } from "node:fs/promises";
import { chromium } from "playwright";

const HOST = "127.0.0.1";
const PORT = 4173;
const MAX_BODY = 128_000;
const MAX_TEXT = 40_000;
const MAX_RESPONSE = 480_000;

const context = await chromium.launchPersistentContext("/profile", {
	headless: true,
	viewport: { width: 1280, height: 800 },
	serviceWorkers: "block",
});
let page = context.pages()[0] ?? await context.newPage();
async function preparePage(target) {
	await target.route("**/*", (route) => {
	try {
		const protocol = new URL(route.request().url()).protocol;
		return protocol === "http:" || protocol === "https:" ? route.continue() : route.abort();
	} catch { return route.abort(); }
	});
}
await preparePage(page);
const lastUrlPath = "/profile/.last-url";
async function restoreLastPage() {
	try {
		if ((await lstat(lastUrlPath)).isSymbolicLink()) return;
		const savedUrl = await readFile(lastUrlPath, "utf8");
		if (savedUrl) {
			const parsed = new URL(savedUrl);
			if (parsed.protocol === "http:" || parsed.protocol === "https:") await page.goto(parsed.href, { waitUntil: "domcontentloaded", timeout: 10_000 });
		}
	} catch { /* Keep the browser available if the last site is offline. */ }
}
let restorePromise = Promise.resolve();

const active = new Map();
const cancelled = new Set();
let queue = Promise.resolve();

function locate(locator) {
	if (!locator || typeof locator !== "object") throw new Error("locator is required");
	if (locator.by === "role") return page.getByRole(locator.role, { name: locator.name, exact: locator.exact });
	if (locator.by === "label") return page.getByLabel(locator.value, { exact: locator.exact });
	if (locator.by === "placeholder") return page.getByPlaceholder(locator.value, { exact: locator.exact });
	if (locator.by === "text") return page.getByText(locator.value, { exact: locator.exact });
	if (locator.by === "css") return page.locator(locator.value);
	throw new Error("unsupported locator type");
}

async function snapshot() {
	const pageData = await page.evaluate((maxText) => {
		const text = (document.body?.innerText ?? "").slice(0, maxText);
		const links = Array.from(document.querySelectorAll("a[href]"), (a) => ({
			text: (a.innerText || a.getAttribute("aria-label") || "").trim().slice(0, 500),
			href: a.href.slice(0, 4096),
		})).slice(0, 200);
		const controls = Array.from(document.querySelectorAll("button,input,textarea,select,[role=button],[role=link],[role=checkbox],[role=radio],[role=tab]"), (node) => ({
			tag: node.tagName.toLowerCase(),
			role: node.getAttribute("role") || undefined,
			type: node.getAttribute("type") || undefined,
			name: (node.getAttribute("aria-label") || node.getAttribute("name") || node.getAttribute("placeholder") || ("innerText" in node ? node.innerText : "") || "").slice(0, 500),
			value: "value" in node && node.type !== "password" ? String(node.value).slice(0, 500) : undefined,
			text: ("innerText" in node ? node.innerText : "").trim().slice(0, 300),
			disabled: "disabled" in node ? node.disabled : node.getAttribute("aria-disabled") === "true",
		})).slice(0, 200);
		return { title: document.title.slice(0, 512), url: location.href.slice(0, 4096), text, links, controls };
	}, MAX_TEXT);
	return pageData;
}

async function perform(action, signal) {
	if (signal.aborted) throw new Error("aborted");
	switch (action?.action) {
		case "navigate": {
			let url;
			try { url = new URL(action.url); } catch { throw new Error("navigate requires a valid http(s) URL"); }
			if (!/^https?:$/.test(url.protocol) || url.username || url.password) throw new Error("navigate only accepts http(s) URLs without embedded credentials");
			await page.goto(url.href, { waitUntil: "domcontentloaded", timeout: 30_000 });
			await writeFile(`${lastUrlPath}.tmp`, url.href, { mode: 0o600 });
			await rename(`${lastUrlPath}.tmp`, lastUrlPath);
			return snapshot();
		}
		case "snapshot": return snapshot();
		case "click": await locate(action.locator).click({ timeout: 10_000 }); return snapshot();
		case "fill":
			if (typeof action.value !== "string" || action.value.length > 16_000) throw new Error("fill value is too large");
			await locate(action.locator).fill(action.value, { timeout: 10_000 }); return snapshot();
		case "press":
			if (typeof action.key !== "string" || action.key.length > 40) throw new Error("invalid key");
			await locate(action.locator).press(action.key, { timeout: 10_000 }); return snapshot();
		case "back":
			await page.goBack({ waitUntil: "domcontentloaded", timeout: 15_000 });
			if (/^https?:$/.test(new URL(page.url()).protocol)) {
				await writeFile(`${lastUrlPath}.tmp`, page.url(), { mode: 0o600 });
				await rename(`${lastUrlPath}.tmp`, lastUrlPath);
			}
			return snapshot();
		case "screenshot": {
			const data = await page.screenshot({ type: "png", fullPage: false });
			if (data.byteLength > 350_000) throw new Error("screenshot exceeded the output limit");
			return { url: page.url(), mimeType: "image/png", base64: data.toString("base64") };
		}
		default: throw new Error("unsupported browser action");
	}
}

function send(res, value, status = 200) {
	let body = JSON.stringify(value);
	if (Buffer.byteLength(body) > MAX_RESPONSE) {
		body = JSON.stringify({ ok: false, error: "browser response exceeded the output limit" });
		status = 413;
	}
	res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(body) });
	res.end(body);
}

const server = createServer(async (req, res) => {
	const url = new URL(req.url, `http://${HOST}:${PORT}`);
	if (url.pathname === "/action" || url.pathname === "/cancel") {
		if (!process.env.CRUMBLE_BROWSER_TOKEN || req.headers["x-crumble-browser-token"] !== process.env.CRUMBLE_BROWSER_TOKEN) {
			return send(res, { ok: false, error: "unauthorized" }, 401);
		}
	}
	if (process.env.CRUMBLE_BROWSER_TEST_FIXTURE === "1" && req.method === "GET" && url.pathname === "/fixture/set") {
		res.setHeader("set-cookie", "browser_smoke=stored; Path=/; SameSite=Lax");
		res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
		return res.end("<!doctype html><title>Browser fixture</title><label>Name <input placeholder='Your name'></label><button>Save</button><p id='out'>Ready</p><script>document.querySelector('button').onclick=()=>document.querySelector('#out').textContent='Hello '+document.querySelector('input').value</script>");
	}
	if (process.env.CRUMBLE_BROWSER_TEST_FIXTURE === "1" && req.method === "GET" && url.pathname === "/fixture/cookies") {
		res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
		return res.end(`<!doctype html><title>Cookie fixture</title><p>${req.headers.cookie ?? "no-cookie"}</p>`);
	}
	if (req.method === "GET" && url.pathname === "/health") return send(res, { ok: true });
	if (req.method === "GET" && url.pathname === "/cancel") {
		const id = url.searchParams.get("id");
		if (id) {
			cancelled.add(id);
			active.get(id)?.abort();
		}
		return send(res, { ok: true });
	}
	if (req.method !== "POST" || url.pathname !== "/action") return send(res, { ok: false, error: "not found" }, 404);
	let raw = "";
	try {
		for await (const chunk of req) {
			raw += chunk;
			if (raw.length > MAX_BODY) throw new Error("browser request is too large");
		}
		const payload = JSON.parse(raw);
		if (typeof payload.id !== "string" || payload.id.length > 80) throw new Error("invalid action id");
		let finish;
		const run = new Promise((resolve) => { finish = resolve; });
		const result = queue.then(async () => {
			await restorePromise;
			const controller = new AbortController();
			active.set(payload.id, controller);
			if (cancelled.delete(payload.id)) controller.abort();
			const target = page;
			const resetOnCancel = async () => {
				if (page !== target) return;
				page = await context.newPage();
				await preparePage(page);
				await target.close().catch(() => undefined);
			};
			controller.signal.addEventListener("abort", () => void resetOnCancel(), { once: true });
			try { return { ok: true, result: await perform(payload.action, controller.signal) }; }
			catch (error) { return { ok: false, error: String(error?.message ?? error).slice(0, 2_000) }; }
			finally { active.delete(payload.id); }
		});
		queue = result.then(finish, (error) => finish({ ok: false, error: String(error) }));
		return send(res, await run);
	} catch (error) {
		return send(res, { ok: false, error: String(error?.message ?? error).slice(0, 2_000) }, 400);
	}
});

server.listen(PORT, HOST, () => { restorePromise = restoreLastPage(); });
async function shutdown() {
	server.close();
	await context.close();
	process.exit(0);
}
process.once("SIGTERM", () => void shutdown());
process.once("SIGINT", () => void shutdown());
