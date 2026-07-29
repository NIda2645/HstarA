# Unified Startup Title Shine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Subagents are disabled for this project.

**Goal:** Render the three-star mark and `Hstar 正在启动中` as one clipped title silhouette traversed by one continuous left-to-right highlight.

**Architecture:** Replace the separate SVG-star and HTML-text effects with one SVG whose clip path contains both the star paths and the title text. Animate one oversized gradient rectangle through that shared clip path so element width, font rendering, and window scaling cannot create independent phases.

**Tech Stack:** Local HTML, CSS animations, SVG clip paths, .NET 8, xUnit, Codex in-app browser

---

### Task 1: Define the unified-animation contract

**Files:**
- Modify: `desktop/Hstar.Desktop.Tests/StartupAssetTests.cs`

- [ ] **Step 1: Replace the separate-animation assertions**

Update `StartupAssetsAreLocalAndUseApprovedLightfallConfiguration` so its title assertions are:

```csharp
Assert.Contains("startup-title", css);
Assert.Contains("animation: title-shiny-sweep 2s linear infinite", css);
Assert.Contains("class=\"startup-title-art\"", html);
Assert.Contains("class=\"startup-title-clip-text\"", html);
Assert.Contains("display: block", css);
Assert.Contains("width: max-content", css);
Assert.Contains("#b5b5b5", html);
Assert.Contains("#ffffff", html);
Assert.DoesNotContain("title-pulse", css);
Assert.DoesNotContain("opacity: 0.72", css);
Assert.DoesNotContain("title-mask", html);
```

Replace `StartupTitleAndMarkUseTheSameLeftToRightShinyTextEffect` with:

```csharp
[Fact]
public void StartupTitleAndMarkUseOneContinuousLeftToRightShine()
{
    var html = File.ReadAllText(Asset("index.html"));
    var css = File.ReadAllText(Asset("startup.css"));
    const string animation = "animation: title-shiny-sweep 2s linear infinite";

    Assert.Contains("id=\"startup-title-shape\"", html);
    Assert.Contains("<text class=\"startup-title-clip-text\"", html);
    Assert.Contains("clip-path=\"url(#startup-title-shape)\"", html);
    Assert.Contains("class=\"startup-title-highlight\"", html);
    Assert.Contains("id=\"startup-title-shine\"", html);
    Assert.DoesNotContain("class=\"startup-label\"", html);
    Assert.DoesNotContain("class=\"startup-mark-highlight\"", html);
    Assert.DoesNotContain("<animate", html);
    Assert.Contains(animation, css);
    Assert.Equal(
        css.IndexOf(animation, StringComparison.Ordinal),
        css.LastIndexOf(animation, StringComparison.Ordinal));
    Assert.Contains("transform-box: fill-box", css);
    Assert.Contains("transform: translateX(150%)", css);
    Assert.DoesNotContain("@keyframes mark-shiny-sweep", css);
    Assert.DoesNotContain("@keyframes shiny-sweep", css);
}
```

- [ ] **Step 2: Run the focused test and confirm the old structure fails**

Run:

```powershell
dotnet test desktop/Hstar.Desktop.Tests/Hstar.Desktop.Tests.csproj --filter "FullyQualifiedName~StartupAssetTests" --no-restore
```

Expected: `StartupAssetTests` fails because the current HTML has separate `startup-mark-highlight` and `startup-label` elements and the CSS has two animations.

### Task 2: Build one clipped SVG title

**Files:**
- Modify: `desktop/Hstar.Desktop/Assets/startup/index.html`
- Modify: `desktop/Hstar.Desktop/Assets/startup/startup.css`
- Test: `desktop/Hstar.Desktop.Tests/StartupAssetTests.cs`

- [ ] **Step 1: Replace the title artwork with one SVG silhouette**

Keep the existing outer `.startup-title` status element and replace its contents with:

```html
<div class="startup-title-content">
  <svg class="startup-title-art"
       viewBox="0 0 598.73 100"
       aria-hidden="true"
       focusable="false">
    <defs>
      <clipPath id="startup-title-shape" clipPathUnits="userSpaceOnUse">
        <path d="M58 5C61 32 68 40 98 45C68 50 61 58 58 94C55 58 48 50 14 45C48 40 55 32 58 5Z" />
        <path d="M106 9C108 22 112 26 126 29C112 32 108 36 106 51C104 36 100 32 86 29C100 26 104 22 106 9Z" />
        <path d="M112 57C114 69 118 73 132 76C118 79 114 83 112 96C110 83 106 79 92 76C106 73 110 69 112 57Z" />
        <text class="startup-title-clip-text" x="155.56" y="50" dy=".35em">Hstar 正在启动中</text>
      </clipPath>
      <linearGradient id="startup-title-shine"
                      x1="0%"
                      y1="0%"
                      x2="100%"
                      y2="0%"
                      gradientTransform="rotate(120 .5 .5)">
        <stop offset="0%" stop-color="#b5b5b5" />
        <stop offset="35%" stop-color="#b5b5b5" />
        <stop offset="50%" stop-color="#ffffff" />
        <stop offset="65%" stop-color="#b5b5b5" />
        <stop offset="100%" stop-color="#b5b5b5" />
      </linearGradient>
    </defs>
    <g clip-path="url(#startup-title-shape)">
      <rect width="598.73" height="100" fill="#b5b5b5" />
      <rect class="startup-title-highlight"
            x="-1197.46"
            width="1197.46"
            height="100"
            fill="url(#startup-title-shine)" />
    </g>
  </svg>
</div>
```

- [ ] **Step 2: Replace both old animations with one title-wide sweep**

Use these title styles, removing `.startup-mark`, `.startup-mark-highlight`, `.startup-label`, `shiny-sweep`, and `mark-shiny-sweep`:

```css
.startup-title-content {
  display: block;
  width: min(431px, calc(100vw - 72px));
}

.startup-title-art {
  display: block;
  width: 100%;
  height: auto;
  overflow: visible;
}

.startup-title-clip-text {
  font-family: "Segoe UI", "Microsoft YaHei UI", sans-serif;
  font-size: 55.56px;
  font-weight: 800;
  letter-spacing: 0;
}

.startup-title-highlight {
  transform-box: fill-box;
  transform-origin: left center;
  animation: title-shiny-sweep 2s linear infinite;
}

@keyframes title-shiny-sweep {
  from { transform: translateX(0); }
  to { transform: translateX(150%); }
}

@media (prefers-reduced-motion: reduce) {
  .startup-title-highlight {
    animation: none;
    transform: translateX(75%);
  }
}
```

- [ ] **Step 3: Run the focused startup-asset tests**

Run:

```powershell
dotnet test desktop/Hstar.Desktop.Tests/Hstar.Desktop.Tests.csproj --filter "FullyQualifiedName~StartupAssetTests" --no-restore
```

Expected: all `StartupAssetTests` pass.

### Task 3: Verify rendering and regressions

**Files:**
- Verify: `desktop/Hstar.Desktop/Assets/startup/index.html`
- Verify: `desktop/Hstar.Desktop/Assets/startup/startup.css`
- Verify: `desktop/Hstar.Desktop.Tests/StartupAssetTests.cs`

- [ ] **Step 1: Run the complete desktop test project**

Run:

```powershell
dotnet test desktop/Hstar.Desktop.Tests/Hstar.Desktop.Tests.csproj --no-restore
```

Expected: the desktop test project passes with zero failures.

- [ ] **Step 2: Check formatting and unintended edits**

Run:

```powershell
git diff --check
git diff -- desktop/Hstar.Desktop/Assets/startup/index.html desktop/Hstar.Desktop/Assets/startup/startup.css desktop/Hstar.Desktop.Tests/StartupAssetTests.cs
```

Expected: `git diff --check` has no output; the diff contains only the unified title artwork, its CSS animation, and matching assertions in addition to the user's pre-existing changes.

- [ ] **Step 3: Reload the live startup preview and inspect it**

Reload `http://127.0.0.1:60345/` in the Codex in-app browser, then verify:

```text
One canvas is rendering the Lightfall background.
The title artwork remains approximately 431 x 72 CSS pixels at the normal viewport.
The title group remains horizontally and vertically centered.
One highlight enters from the left of the first star, crosses all three stars, continues through the complete title, and exits to the right.
The browser console contains no errors.
```

- [ ] **Step 4: Capture two frames from one animation cycle**

Capture screenshots at two points within the same `2s` cycle and compare title-region pixels. Expected: the highlight occupies different horizontal locations while the title bounds and Lightfall canvas remain stable.
