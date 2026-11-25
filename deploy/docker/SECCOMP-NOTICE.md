# Chromium seccomp profile

Derived from the current Moby default seccomp profile, revision `6fe7deb1b9fb7c0397a4593480d7d22b9ee8caef`:
https://raw.githubusercontent.com/moby/profiles/6fe7deb1b9fb7c0397a4593480d7d22b9ee8caef/seccomp/default.json

The upstream Apache-2.0 license is preserved in `SECCOMP-LICENSE`.
Following https://playwright.dev/docs/docker#crawling-and-scraping, an unconditional allow rule for clone, setns and unshare permits Chromium user namespace sandboxing. Other rules, including clone3 fallback behavior, are unchanged. Modern Docker/runc require the current default profile syscall coverage; the older standalone Playwright profile omits openat2 and cannot be used on this host.
