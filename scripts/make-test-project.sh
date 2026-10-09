#!/bin/sh
# Creates a throwaway demo project in the selected tenant's private workspaces.
set -eu

root="$(cd "$(dirname "$0")/.." && pwd)"
dir="$(cd "$root" && bun --no-env-file -e 'import {loadAppConfig} from "./src/config/config.ts"; import {prepareTenant} from "./src/tenants/tenants.ts"; const config=loadAppConfig(); const tenant=config.tenants.find(t=>t.id===config.selectedTenantId); prepareTenant(tenant); process.stdout.write(tenant.workspacesDir);')/demo"
if [ -e "$dir" ]; then
  echo "$dir already exists" >&2
  exit 1
fi

mkdir -p "$dir"
cd "$dir"

cat > package.json <<'EOF'
{
  "name": "demo",
  "private": true,
  "type": "module",
  "scripts": { "test": "node --test" }
}
EOF

cat > greet.js <<'EOF'
export function greet(name) {
  return `Hello, ${name}!`;
}
EOF

cat > greet.test.js <<'EOF'
import assert from "node:assert/strict";
import { test } from "node:test";
import { greet } from "./greet.js";

test("greet", () => {
  assert.equal(greet("Ada"), "Hello, Ada!");
});
EOF

git init -q
git add .
git -c user.name=crumble -c user.email=crumble@localhost commit -q -m "Initial demo project"
echo "Created $dir"
