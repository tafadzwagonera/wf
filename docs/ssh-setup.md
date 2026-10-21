# SSH Multi-Account Setup for macOS

This runbook guides you through setting up SSH keys for managing two separate git identities:
- **Personal**: GitHub account `tafadzwagonera`
- **Work**: Bitbucket account (Tour Axis org)

> **Automated**: `nr setup:ssh` (`scripts/setup-ssh.ts`) runs this runbook end-to-end on macOS and Linux, skipping steps that are already done. The sections below remain the manual reference.

## 1. Prerequisites

Check existing SSH keys:
```bash
ls ~/.ssh/id_*
```

Verify ssh-agent is running:
```bash
eval "$(ssh-agent -s)"
```

## 2. Generate SSH Key Pairs

Generate a personal key for GitHub:
```bash
ssh-keygen -t ed25519 -C "personal@email.com" -f ~/.ssh/id_ed25519_personal
```

Generate a work key for Bitbucket:
```bash
ssh-keygen -t ed25519 -C "work@email.com" -f ~/.ssh/id_ed25519_work
```

Add both keys to ssh-agent with keychain integration:
```bash
ssh-add --apple-use-keychain ~/.ssh/id_ed25519_personal
ssh-add --apple-use-keychain ~/.ssh/id_ed25519_work
```

## 3. Register Public Keys with Hosting Platforms

**For GitHub (Personal):**

Copy the public key:
```bash
pbcopy < ~/.ssh/id_ed25519_personal.pub
```

Then:
1. Go to GitHub → Settings → SSH and GPG keys
2. Click "New SSH key"
3. Paste the key and save

**For Bitbucket (Work):**

Copy the public key:
```bash
pbcopy < ~/.ssh/id_ed25519_work.pub
```

Then:
1. Go to Bitbucket → Personal Settings → SSH keys
2. Click "Add key"
3. Paste the key and save

## 4. Configure `~/.ssh/config`

Add the following configuration to your `~/.ssh/config` file (create it if it doesn't exist):

```
# Personal GitHub account
Host github.com-personal
  HostName github.com
  User git
  IdentityFile ~/.ssh/id_ed25519_personal
  AddKeysToAgent yes
  UseKeychain yes

# Work Bitbucket account
Host bitbucket.org-work
  HostName bitbucket.org
  User git
  IdentityFile ~/.ssh/id_ed25519_work
  AddKeysToAgent yes
  UseKeychain yes
```

## 5. Update the wf Repository Remote

Update your repository remote to use the personal SSH host alias:

```bash
git remote set-url origin git@github.com-personal:tafadzwagonera/wf.git
```

Verify the change:
```bash
git remote get-url origin
```

Expected output:
```
git@github.com-personal:tafadzwagonera/wf.git
```

## 6. Verify SSH Connections

Test your personal GitHub connection:
```bash
ssh -T git@github.com-personal
```

Expected output:
```
Hi tafadzwagonera! You've successfully authenticated...
```

Test your work Bitbucket connection:
```bash
ssh -T git@bitbucket.org-work
```

Expected output:
```
logged in as <work-account>...
```

## 7. Verify Git Identity

Check the git user email in the wf repository:
```bash
git log --format="%ae" -1
```

Expected output: Your personal email address

Verify git push works without prompting for a password:
```bash
git push origin HEAD --dry-run
```

Expected: No password prompt and no error.

## Notes

- **macOS Ventura+**: The `UseKeychain yes` directive automatically stores and retrieves passphrases from macOS Keychain.
- **Bitbucket**: SSH keys work for `git+ssh` operations. API tokens (not app passwords) are required for REST API calls.
- **Linux users**: Omit the `UseKeychain yes` lines and manage `ssh-add` manually or add it to your shell profile.
