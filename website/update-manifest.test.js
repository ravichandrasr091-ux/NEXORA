"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const downloads = path.join(__dirname, "downloads");

test("latest update catalog matches the downloadable Smart Chamber APK", () => {
  const release = JSON.parse(fs.readFileSync(path.join(downloads, "latest.json"), "utf8"));
  assert.equal(release.schemaVersion, 1);
  assert.equal(release.packageName, "com.nexora.smartchamber");
  assert.equal(release.versionCode, 7);
  assert.equal(release.versionName, "2.7");
  assert.match(release.apkFile, /^nexora-smart-chamber-v2\.7\.apk$/);
  assert.match(release.sha256, /^[a-f0-9]{64}$/i);

  const apk = fs.readFileSync(path.join(downloads, release.apkFile));
  const checksum = createHash("sha256").update(apk).digest("hex");
  assert.equal(checksum, release.sha256.toLowerCase());
});
