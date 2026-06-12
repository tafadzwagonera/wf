#!/usr/bin/env node
const os = require('os');
const fs = require('fs');
const path = require('path');

const WF_HOME = path.join(os.homedir(), '.wf');
const DIRS = [WF_HOME, path.join(WF_HOME, 'logs'), path.join(WF_HOME, 'state')];

for (const dir of DIRS) {
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (err) {
    console.error(`Failed to create directory ${dir}: ${err.message}`);
    process.exit(1);
  }
}
