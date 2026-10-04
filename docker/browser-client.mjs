let input = "";
for await (const chunk of process.stdin) {
	input += chunk;
	if (input.length > 128_000) throw new Error("browser request is too large");
}

const request = JSON.parse(input || "{}");
const path = request.health ? "/health" : request.cancel ? `/cancel?id=${encodeURIComponent(request.cancel)}` : "/action";
const response = await fetch(`http://127.0.0.1:4173${path}`, {
	method: request.health || request.cancel ? "GET" : "POST",
	headers: { "x-crumble-browser-token": process.env.CRUMBLE_BROWSER_TOKEN ?? "", ...(request.action ? { "content-type": "application/json" } : {}) },
	body: request.action ? JSON.stringify(request) : undefined,
	signal: request.action ? AbortSignal.timeout(50_000) : undefined,
});
const text = await response.text();
if (!response.ok) throw new Error(`browser server returned ${response.status}: ${text.slice(0, 2_000)}`);
process.stdout.write(text);
