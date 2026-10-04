// Live check of the suspend-and-resume assumption: a worker asks a question, its process ends,
// and the job resumes with the answer and its earlier history. Calls the real model.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadAppConfig, createRunner } from "../src/config.ts";
import { type Job, JobStore } from "../src/jobs.ts";
import { Supervisor } from "../src/supervisor.ts";
import { prepareTenant } from "../src/tenants.ts";

const PHRASE = "Bis bald und alles Gute";
const BRIEF =
	"Add an exported function farewell(name) to greet.js with a test in greet.test.js, and run the tests. " +
	"The person has a preferred farewell phrase that is not written down anywhere. Ask for it before writing any code. " +
	"In your final summary, include the output of `uname -s`.";

const config = loadAppConfig();
const tenant = config.tenants.find((item) => item.id === config.selectedTenantId)!;
prepareTenant(tenant);
const workspace = join(tenant.workspacesDir, "demo");
assert.ok(!readFileSync(join(workspace, "greet.js"), "utf8").includes(PHRASE), "demo project is in its initial state");

mkdirSync(config.jobsDir, { recursive: true });
const store = new JobStore(tenant.jobsDatabasePath);

let settle: ((job: Job) => void) | undefined;
const nextSettled = () => new Promise<Job>((resolve) => (settle = resolve));
const supervisor = new Supervisor({
	store,
	runner: createRunner(tenant, config),
	askExtension: config.askExtension,
	provider: tenant.provider,
	model: tenant.model,
	onSettled: (job) => settle?.(job),
});

let waiting = nextSettled();
const started = supervisor.delegate("demo", BRIEF);
console.log(`job ${started.id} started`);

const parked = await waiting;
console.log(`first run settled: ${parked.status}\nquestion: ${parked.question}\nerror: ${parked.error}`);
assert.equal(parked.status, "waiting");
assert.ok(parked.question);

waiting = nextSettled();
supervisor.message(parked.id, `The phrase is "${PHRASE}, <name>!"`);
const finished = await waiting;
console.log(`second run settled: ${finished.status}\nsummary: ${finished.summary}\nerror: ${finished.error}`);
assert.equal(finished.status, "done");

if (process.env.CRUMBLE_RUNNER !== "host") assert.match(finished.summary ?? "", /Linux/, "tools ran in the sandbox");
assert.ok(readFileSync(join(workspace, "greet.js"), "utf8").includes(PHRASE), "greet.js contains the answered phrase");
execFileSync("npm", ["test"], { cwd: workspace, stdio: "inherit" });
console.log("spike passed");
store.close();
