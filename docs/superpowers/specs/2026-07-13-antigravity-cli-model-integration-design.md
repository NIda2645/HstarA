# Antigravity CLI Model Integration Design

## Objective

Connect HstarA's Antigravity CLI provider settings to the locally installed `agy` CLI so that model discovery and model selection affect real CLI execution. Also provide a safe button that opens an interactive Antigravity CLI terminal for account status and other manual operations.

## Scope

This change covers only the Antigravity CLI provider (`gemini-cli` protocol):

- Discover the current model list by running `agy models` whenever the user requests it.
- Let the user independently choose which discovered models are saved as chat models and image-generation models.
- Pass the exact selected model to each Antigravity CLI request.
- Add a visible **启动** button beside **帮助** that opens an independent interactive `agy` terminal.

It does not hardcode the models visible in the reference screenshot, change other API providers, or introduce shared global model switching.

## Model Discovery

The backend will provide a dedicated Antigravity model-discovery function. Every click on **拉取模型** runs the installed CLI in non-interactive mode:

```text
agy models
```

The command has a bounded timeout. Its standard output is normalized by removing ANSI/control sequences, trimming lines, discarding empty or known non-model status lines, and deduplicating names while preserving CLI order.

The CLI output is the source of truth. The implementation does not assume a fixed count or fixed model names. Models shown in the reference screenshot are current examples only and must not be embedded as a permanent list.

The provider fetch-models endpoint returns the discovered list for both available chat choices and available image-generation choices. These are discovery results, not automatic selections.

## Selection UI And Persistence

The fetch-models result view contains separate selection areas for:

- Chat models
- Image-generation models

Both areas start from the same real-time discovered list, but their selections are independent. The user explicitly confirms the selections before they are written to the current Antigravity provider configuration.

Existing selections that still appear in the discovered list remain selected when the result view opens. A failed discovery never clears or replaces saved selections. If the provider has never been configured and no usable model can be discovered, `auto` remains the fallback rather than a claimed discovered model.

Canvas model selectors continue to read their respective saved provider lists. Reopening API settings must preserve both independent selections.

## Runtime Model Linkage

Each canvas request carries its selected model through the existing provider request payload. The backend passes that exact value as a distinct process argument:

```text
agy --model "Claude Sonnet 4.6 (Thinking)" ...
```

Argument-array process execution must be used so spaces and parentheses cannot split or alter the model name. If a request has no selected model, the backend may use `auto` as a compatibility fallback.

The application must not change Antigravity's interactive global current model. Per-request `--model` arguments keep simultaneous canvas nodes independent and prevent one node from changing another node's model.

An older canvas may still reference a model that is no longer in the most recently saved list. HstarA should allow the request and log a warning, leaving final validation to the CLI, so provider updates do not silently rewrite existing canvas data.

## Interactive Launch Button

A **启动** button with a terminal icon will appear immediately to the right of **帮助** in the Antigravity CLI account panel. It uses the same size and visual language as the existing action buttons.

Clicking it calls a localhost-only backend endpoint that opens a separate visible Windows PowerShell or Windows Terminal window and starts:

```text
agy
```

The terminal is interactive and remains available until the user closes it. It is independent from model discovery and canvas execution. Multiple clicks may open multiple independent sessions.

The launch endpoint accepts no command text or executable path from the browser. It runs only the fixed Antigravity CLI command, preventing it from becoming a general command-execution endpoint.

## Error Handling

- Missing executable: report that Antigravity CLI is not installed or not available on `PATH`.
- Discovery timeout: terminate the discovery process, report a concise timeout message, and retain saved models.
- Non-zero exit: report the exit status and a sanitized summary of CLI output without overwriting saved models.
- Empty parsed result: treat it as a failed discovery, not as a valid empty model list.
- Launch failure: report that the interactive terminal could not be opened and include a concise local error.
- Unsupported/headless environment: reject visible-terminal launch with a clear message.
- Runtime model rejection: stop the affected task through the existing failure path and record the CLI error in application logs.

## Security And Concurrency

- Discovery and launch endpoints are restricted to local requests under the application's existing local-server assumptions.
- No endpoint accepts arbitrary shell commands.
- Subprocesses receive argument arrays rather than interpolated shell command strings where possible.
- Discovery has a timeout; the interactive terminal intentionally does not.
- Canvas requests use independent `--model` arguments and do not share mutable model state.

## Verification

Automated tests will cover:

1. Parsing arbitrary `agy models` output, including ANSI sequences, blank lines, duplicate names, and variable model counts.
2. Discovery timeout, missing executable, non-zero exit, and empty-result behavior.
3. The fetch-models endpoint returning current discovered models without static `auto` replacement.
4. Independent chat and image model selection persistence.
5. Exact model propagation from provider settings through a canvas request to the `agy --model` process argument.
6. Concurrent requests retaining different per-request models.
7. The launch endpoint invoking only the fixed `agy` executable and rejecting unsupported environments safely.
8. Frontend placement and behavior of **拉取模型** and **启动** controls.

Manual acceptance on the current Windows engineering environment will verify:

1. Repeated **拉取模型** clicks reflect the current output of the installed `agy models` command.
2. Chat and image-generation selections can differ and survive reopening settings.
3. Selecting different models in the canvas produces matching backend `--model` arguments and real CLI behavior.
4. **启动** opens a visible interactive Antigravity CLI window that can display account state and accept normal CLI operations.
5. Discovery and canvas operations remain functional whether or not an interactive CLI window is open.

## Success Criteria

The feature is complete when HstarA discovers Antigravity models dynamically, persists user-confirmed chat and image selections independently, uses the selected model in the actual Antigravity CLI invocation, and reliably opens a safe independent interactive CLI terminal from the provider settings page.
