---
name: File Operations Demo
description: Demonstrate file operation capabilities
autoExecutionMode: true
version: 1.0.0
tags:
  - demo
  - file
  - example
---

# File Operations Workflow

A demonstration workflow showing file operation capabilities.

## Invocation

```bash
windsurf-agent run example-file-operations
```

## Execution Steps

### Step 1: Create Test Directory

- Create a temporary directory
- Verify directory was created

### Step 2: Write Files

- Write a text file
- Write a JSON configuration file
- Write a markdown file

### Step 3: Read and Validate

- Read each file back
- Validate content matches
- Display file contents

### Step 4: Cleanup

- Delete temporary files
- Remove test directory
- Confirm cleanup completed

## Evaluation Criteria

- All files created successfully
- File contents are correct
- Cleanup removes all test files
- No errors encountered
