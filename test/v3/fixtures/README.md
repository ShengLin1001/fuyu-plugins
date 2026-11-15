The v3 tests turn these folders into commits of a local repository standing in
for https://github.com/TixXin/fuyu-plugins (FUYU_MARKET_GIT_MIRROR):
demo-1.0.0 is a clean first release, demo-1.1.0 the same plugin poisoned by an
update (a child process and a domain hidden by string concatenation, like
packages/plugin-review/test/fixtures/weather-1.1.0 in TixXin/fuyu).
