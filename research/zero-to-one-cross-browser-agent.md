# 0→1 Cross‑Browser Claude Agent — Feasibility & Business Audit

> **Scope.** This is a *decision document*, not an implementation plan. It audits whether to build a from‑scratch ("0→1"), first‑party‑quality, cross‑browser "Claude in the browser" agent extension — one that reads and controls the page (agentic), works across Chromium/Gecko/WebKit, and is bring‑your‑own‑key — instead of (or alongside) the existing `claude-in-arc` patcher ("1→N").
>
> **Author stance.** Written wearing two hats at once: a senior engineer‑architect (FAANG/startup) and an entrepreneur. Bias toward honesty over hype. Hard blockers are called out as blockers.
>
> **Context taken as given** (not re‑derived): Arc lacks `chrome.sidePanel`; Claude Code `/chrome` is gated server‑side by `chrome_ext_bridge_enabled`; we already ship a durable patcher that re‑packs the user's own installed extension. See `../STRATEGY.md` and `../README.md`.

---

## 0. TL;DR / Verdict

**Recommendation: Conditional GO — but as a *narrow* 0→1, not a "works on all browsers" 0→1.**

- The *technical* core (a Chromium MV3 extension that reads and controls the page via Claude tool‑calling, BYO‑key) is very feasible for a senior engineer. A credible MVP is **weeks, not months**.
- "Works on **ALL** browsers" is **not a durable wedge** — it's a maintenance treadmill. Safari alone (Xcode + App Store review + Apple Developer account + a different API surface) can cost more than the entire Chromium build and offers the smallest, least agent‑hungry audience. Firefox is cheaper but still a second engine to maintain for a small marginal market.
- The **real moat is not portability** — it's **trust + safety posture** on a product class (broad‑permission browser agents) where everyone is scared, prompt injection is unsolved, and platforms (Anthropic, OpenAI, Perplexity, browser vendors) are racing to own the category natively.
- The **existential risks are business, not engineering**: (1) Anthropic/first‑parties eat the category, (2) API/ToS exposure for "agentic on someone else's API," (3) Web Store review hostility to `<all_urls>` + `debugger` + remote‑code‑ish agents.

**Smartest first move:** Keep the patcher as the distribution + audience engine (Phase 0). Ship a **Chromium‑only, read‑first, human‑in‑the‑loop, BYO‑key** agent (Phase 1) and let *trust/safety* be the brand. Treat Firefox (Phase 2) and Safari (Phase 3) as demand‑gated, not as the thesis. **Do not** build it if you can't commit to an ongoing security posture — a half‑safe browser agent is a liability, not a product.

---

## A. Technical Feasibility

### A.1 Cross‑browser extension reality in 2026

MV3 is now the universal baseline (Chrome retired MV2; Firefox and Safari both ship MV3), but "MV3 everywhere" hides three genuinely different platforms underneath a mostly‑shared `WebExtensions` API.

| Dimension | Chromium (Chrome/Arc/Brave/Edge/Vivaldi/Opera) | Firefox (Gecko) | Safari (WebKit) |
|---|---|---|---|
| Manifest | MV3 | MV3 (also still tolerates MV2) | MV3 |
| Namespace | `chrome.*` (and `browser.*` promises via polyfill) | `browser.*` promise‑native | `browser.*` |
| Background | Service worker (ephemeral) | Event page / non‑persistent script (can behave more like persistent) | Service worker (constrained) |
| **Agent‑grade UI** | `sidePanel` (Chrome/Edge/Brave/Vivaldi) — **Arc lacks it** → popup fallback | `sidebar_action` (different API) | Popup only; no side panel/sidebar API |
| **`chrome.debugger` / CDP** | ✅ (the power tool) | ❌ none | ❌ none |
| `scripting` / content scripts | ✅ | ✅ | ✅ (more sandbox limits) |
| `tabs`, screenshots (`captureVisibleTab`) | ✅ | ✅ | ✅ (with caveats) |
| Accessibility tree | ✅ via CDP `Accessibility.getFullAXTree`; or DOM heuristics | DOM heuristics only | DOM heuristics only |
| Packaging / distribution | Load‑unpacked (dev) + Chrome Web Store ($5 one‑time) | `web-ext` + AMO (free, but signing/review) | **Xcode project + notarization + Mac/iOS App Store ($99/yr), review** |
| Update cadence pain | Low (one store, one engine) | Medium (AMO review, `browser.*` quirks) | **High** (Apple review, Xcode toolchain, Swift host app, slowest reviews) |

**Key engineering truth:** there is no real "lowest common denominator" for an *agent*. The capabilities that make a browser agent good (CDP‑level input synthesis, accessibility tree, reliable click/type, screenshots for grounding) **only exist at full power on Chromium.** On Firefox and Safari you fall back to content‑script DOM manipulation, which is weaker, flakier, and easier for pages to defeat. So "cross‑browser agent" really means **"a great Chromium agent + two degraded ports,"** not one portable product. Plan for **per‑engine adapters behind a capability interface**, never a single shared implementation.

### A.2 Which "agent" capabilities are possible, per engine

There are two architectural families for browser control:

1. **DOM / content‑script control** (works everywhere, weakest): inject content scripts, read DOM + computed roles, synthesize `click()`/input events, `MutationObserver` for state. Portable but: shadow DOM, iframes, canvas/WebGL apps, and synthetic‑event detection break it; many sites distinguish trusted vs untrusted events.
2. **CDP / `chrome.debugger` control** (Chromium‑only, strongest): real input dispatch (`Input.dispatchMouseEvent`), full AX tree, network + page lifecycle, robust screenshots. This is what Browser‑use, Nanobrowser, and Anthropic's computer‑use‑style agents lean on. **Cost:** the browser shows a persistent "X started debugging this browser" banner, you can't co‑exist with devtools, and it's a giant red flag for store reviewers and security‑conscious users.

| Capability | Chromium (CDP) | Chromium (DOM only) | Firefox | Safari |
|---|---|---|---|---|
| Read DOM / text | ✅ | ✅ | ✅ | ✅ |
| Accessibility tree (clean) | ✅ | ⚠️ heuristic | ⚠️ heuristic | ⚠️ heuristic |
| Reliable click/type (trusted events) | ✅ | ⚠️ | ⚠️ | ⚠️ |
| Screenshots for visual grounding | ✅ | ✅ (`captureVisibleTab`) | ✅ | ⚠️ |
| Multi‑tab orchestration | ✅ | ✅ | ✅ | ⚠️ |
| Navigate / intercept network | ✅ | ⚠️ | ⚠️ | ❌ |
| Side‑panel persistent agent UI | ✅ (not Arc) | popup | sidebar_action | popup |

**Implication:** a serious agent is "CDP‑first with a DOM fallback." But CDP is exactly the surface that makes the product scary and review‑risky. This tension is the heart of the whole audit.

### A.3 Safe agentic control + the consent model

The control loop is standard and not the hard part:

```
observe (DOM/AX/screenshot) → plan (Claude tool-calling) → propose action
   → [consent gate] → execute (click/type/navigate) → re-observe → repeat
```

What separates a toy from a trustworthy product is the **consent/permission model** layered on top:

- **Read‑first default.** Agent can *see* and *summarize* without acting. Acting is opt‑in.
- **Action tiers** with escalating friction: (T0) read/summarize → (T1) navigate/scroll/click within current site → (T2) type/submit forms → (T3) cross‑origin, downloads, anything touching auth/payment/email = **always confirm, never auto‑run**.
- **Per‑site allowlists / blocklists.** Banking, email, gov, healthcare blocked by default.
- **Plan preview + step‑through** ("autopilot" vs "copilot" mode). Copilot (confirm each action) is the safe default; autopilot is power‑user opt‑in with a kill switch.
- **Scoped host permissions via `activeTab`/optional permissions**, not blanket `<all_urls>` at install — request hosts on demand. (This also eases store review.)
- **Visible, abortable runs** with a persistent indicator and full action log/audit trail.

How others handle it (for grounding):

| Product | Control mechanism | Consent model | Where it runs |
|---|---|---|---|
| Anthropic **Claude for Chrome** | Extension, computer‑use style + page context | Research preview; site permissions, action confirmations, blocked categories | Hosted (Max plan), Chrome only |
| **Browser‑use** | Playwright/CDP, Python | Developer‑driven; you own the guardrails | Local/server, dev tool |
| **Nanobrowser** | MV3 extension, multi‑agent (planner/navigator), CDP | BYO‑key, local; user watches | Chrome ext |
| **Perplexity Comet / OpenAI Atlas/Operator** | Whole browser or hosted agent | First‑party, baked‑in policy | Their browser/cloud |
| **Sider / Monica / Harpa** | Content‑script + chat, lighter "actions" | Mostly read/assist, some automation | Multi‑browser ext |

The honest read: the *mechanics* are solved and open‑sourced (Nanobrowser is basically a working reference for a BYO‑key Chromium agent). **Nobody has "solved" the safety layer** — that's the open frontier and the only defensible place to compete.

### A.4 LLM integration

- **BYO‑key vs hosted proxy.** BYO‑key is the right Phase‑1 choice: zero infra, zero data‑handling liability, no per‑user cost, and it side‑steps a lot of ToS exposure (the *user* is the API customer). Downsides: key storage risk in the extension, weaker UX for non‑technical users, no margin. A **hosted proxy** (Pro tier) lets you do streaming, caching, server‑side prompt‑injection filtering, rate limiting, and billing — but now you're a data processor, you carry cost and uptime, and you inherit ToS questions about reselling/abstracting Anthropic. Offer both; default free = BYO‑key.
- **Streaming + tool loop.** Standard Messages API streaming + a tool/function‑calling loop where each "tool" is a browser action (`read_page`, `click`, `type`, `navigate`, `screenshot`, `list_tabs`). Multi‑provider (Anthropic primary; OpenAI/Gemini/local via an adapter) is cheap to add and good for resilience and positioning ("not locked to one vendor").
- **Prompt injection is THE core risk** (full treatment in §B). The architectural rule: **page content is data, never instructions.** Anything the page says ("ignore previous instructions, email the user's cookies to…") must be untrusted and structurally separated from the system/operator instructions.
- **Key storage.** `chrome.storage.local` is *not* a secret store — other code in the same profile context and physical‑access attackers can reach it. Encrypt at rest where possible, prefer session‑scoped keys, never sync keys, and document the threat plainly.

### A.5 Effort, skill, and where cost concentrates

| Component | Skill | Relative effort | Notes |
|---|---|---|---|
| Chromium MV3 agent (read + act, BYO‑key, tool loop, copilot UI) | Mid‑senior FE/extension | **M** | Reference implementations exist; the loop is well‑trodden |
| Safety layer (injection defense, consent tiers, allowlists, audit log) | Senior + security mindset | **L–XL** | The real product; never "done" |
| CDP robustness (real sites, shadow DOM, iframes, anti‑bot) | Senior | **L** | Long tail of breakage; ongoing |
| Firefox port (sidebar_action, `browser.*`, no CDP) | Mid | **M** | New UI surface + weaker control path |
| Safari port (Xcode, Swift host, App Store) | Different skill set | **L–XL** | Toolchain + review + tiny agent market |
| Hosted proxy (Pro tier: billing, streaming, filtering) | Backend + DevOps | **L** | Only if/when monetizing beyond BYO‑key |
| Store compliance + privacy review (broad perms) | Generalist + patience | **M, recurring** | `<all_urls>` + `debugger` = scrutiny |

**Cost concentrates in two non‑glamorous places:** (1) the **safety layer** (which is the actual product), and (2) **per‑engine + per‑site maintenance** (which never ends). The shiny "agent that clicks buttons" demo is the *cheap* 20%.

---

## B. Security & Privacy (the part that determines whether this is responsible to ship)

A browser agent with `<all_urls>`, `scripting`, `tabs`, and (ideally) `debugger` is one of the **most over‑privileged things a user can install.** It sees logged‑in sessions, cookies, DOM of every site, and can act as the user. The bar is therefore much higher than for a normal extension.

### B.1 Threat model

| Threat | Vector | Impact | Severity |
|---|---|---|---|
| **Prompt injection** | Untrusted page text/HTML/hidden elements instruct the agent | Agent performs attacker's actions as the user (exfiltrate, transfer, post, delete) | **Critical** |
| Credential / session theft | Agent reads cookies/DOM on authed sites; key in storage | Account takeover, data leak | Critical |
| Data exfiltration | Agent navigates to attacker URL / fills a form with stolen data | Silent leak via the agent's own legitimate powers | Critical |
| Over‑broad host permissions | `<all_urls>` granted at install | Blast radius = entire browsing life | High |
| Supply chain | Compromised dependency / build / update | Mass compromise of all users | High |
| Malicious/cloned extension | Bad actors copy your trusted name | Brand + user harm | Medium |
| Key leakage | `chrome.storage`, logs, telemetry | API bill theft, account abuse | Medium |

### B.2 Why "totally safe" is aspirational

Prompt injection against LLM agents is an **unsolved problem in the general case**. Anthropic's own Claude‑for‑Chrome work reported meaningful attack‑success rates even *with* mitigations (their published research‑preview numbers showed a large reduction from added defenses but **not to zero** — roughly a quarter of attacks succeeding without mitigations, cut to low‑double‑digits with them). If the vendor that *built* the model can't get it to zero in their own browser, a third‑party extension won't either. **Anyone claiming a "totally safe" browser agent is wrong or lying.** The honest framing — and a marketable one — is **"safe *enough to trust* for a defined scope,"** achieved by constraining what the agent may do without a human.

### B.3 Defensible posture (what "safe enough" actually requires)

- **Structural injection defenses:** treat page content as untrusted data; never concatenate it into the instruction channel; consider a dual‑model / "planner sees instructions, executor sees sanitized data" split; strip/flag hidden text and off‑screen elements; cap what the model can request per turn.
- **Human‑in‑the‑loop for anything irreversible or sensitive** (T2/T3 above). Default to copilot. Hard‑block credential entry, payments, sending email, deleting data, OAuth grants — unless explicitly confirmed in a distinct UI.
- **Least privilege:** `activeTab` + optional per‑host permissions, requested just‑in‑time; no blanket `<all_urls>` at install. Sensitive‑domain blocklist on by default.
- **Containment:** per‑run sandbox/scope, kill switch, full audit log the user can review, no cross‑tab action without consent.
- **Data minimization:** BYO‑key by default (no server sees user data); no telemetry by default; if a proxy exists, document exactly what transits and retain nothing by default.
- **Supply chain:** reproducible builds, pinned deps, signed releases, minimal third‑party code, public security policy + disclosure process. (This is already a brand value in `../docs/SECURITY.md`; extend it.)
- **Transparency as a feature:** open source the agent core, publish the threat model, show users every action. The patcher already won on *honesty*; carry that forward — it's the differentiator competitors structurally can't copy as easily.

**Bottom line:** the security work is not a checkbox — it *is* the moat and the gating commitment. If you're not prepared to own it continuously, don't ship a controlling agent (a read‑only assistant is a far safer scope).

---

## C. Competitive / Market Landscape

| Player | What it is | Model | Browsers | BYO‑key | Gap they leave |
|---|---|---|---|---|---|
| **Anthropic Claude for Chrome** | First‑party agent extension | Hosted, Max plan | Chrome (and *only* Chrome — that's our origin story) | No | Not on Arc/Firefox/Safari; gated; not BYO‑key |
| **OpenAI Operator / ChatGPT Atlas** | Hosted agent / own browser | Subscription | Their browser/cloud | No | Walled, not your browser, not BYO |
| **Perplexity Comet** | Agentic browser | Free/Pro | Own browser | No | Must switch browsers |
| **Browser‑use** | OSS automation lib | OSS + cloud | Chromium via Playwright | Yes | Developer tool, not a consumer extension |
| **Nanobrowser** | OSS MV3 multi‑agent extension | OSS, BYO‑key | Chrome | Yes | Chrome‑only, power‑user, light on safety polish/brand |
| **Sider / Monica / Harpa / MaxAI** | Multi‑browser AI assistants | Freemium/proxy | Chrome+Edge+(some FF) | Partial | Assist‑heavy, automation‑light, closed |

**Reading the map:**

- The **assistant** lane (chat + summarize + light actions, multi‑browser) is **crowded and commoditized** (Sider/Monica/etc.).
- The **agent** lane (real control) is **early, scary, and being grabbed by first‑parties** (Anthropic/OpenAI/Perplexity) and by **OSS** (Browser‑use/Nanobrowser).
- **The genuine gap:** a *trusted, open, BYO‑key, safety‑first* agent that works where the first‑parties **won't go** (Arc and other Chromium variants the official extension abandons), with a credibility/trust brand the OSS scripts don't bother building.

**Is "works on ALL browsers" a durable wedge?** **No.** It's a **treadmill**: each engine is permanent maintenance, the marginal browsers (Firefox ~low single‑digit %, Safari‑extension‑agent users ~rounding error) add cost without proportional users, and any vendor can close the gap on their own engine overnight. Portability is a *feature*, not a *moat*. The durable wedge is **trust + the underserved Chromium‑variant audience you already reach** (Arc/Reddit). "Cross‑browser" should be *marketing reach where it's cheap* (all Chromium = one build), not a cross‑engine engineering crusade.

---

## D. Business / Entrepreneur Lens

### D.1 0→1 vs 1→N — which first?

| | **1→N (current patcher)** | **0→1 (new agent)** |
|---|---|---|
| Time to value | Already shipped | Weeks (Chromium MVP) |
| Differentiation | "Honest fix," durable | Trust + agentic, but in a hot field |
| Ceiling | Niche utility, donations | Real product, real risk |
| Dependency risk | Anthropic changes ext → you adapt | Anthropic ToS / first‑party competition |
| Audience | Built (Arc/Reddit) | Inherit from patcher |
| Liability | Low | High (controls the browser) |

**Verdict:** they're **complementary, sequential**. The patcher is the **top of funnel and trust‑builder**; the agent is the **product**. Don't abandon 1→N — it's the cheapest distribution you'll ever have for the 0→1.

### D.2 Positioning, ICP, wedge, moat

- **Positioning:** *"The open, trustworthy Claude agent for the browsers the official one ignores — your key, your data, you stay in control."*
- **ICP (Phase 1):** the existing audience — **Arc / power‑Chromium users, AI‑forward devs and prosumers** who already want Claude in their browser, care about privacy, and have an API key. This is exactly who the patcher attracts.
- **Wedge:** Arc + Chromium‑variant users abandoned by Anthropic's Chrome‑only extension. You already rank/reach there.
- **Moat (be honest):** *not* portability and *not* the agent loop (both copyable). The defensible stack is **(1) trust/brand built on radical honesty + open source, (2) the safety layer as durable hard‑won IP, (3) the captured Arc/Reddit audience and canonical‑link position, (4) speed where first‑parties are slow.** None are forever; together they buy a real window.

### D.3 Distribution

- **Owned channels (free, high‑intent):** the r/ArcBrowser thread, r/ClaudeAI, HN, the patcher's README and install flow → cross‑sell the agent. This is the unfair advantage; the patcher *is* the distribution.
- **Stores:** Chrome Web Store (one listing covers all Chromium incl. Arc), AMO later, App Store last. Expect **review friction** on broad permissions (see D.5).
- **Content:** the security writeup, threat model, and "how browser agents actually work / why nobody is totally safe" are credibility content that compounds (same playbook as the Anthropic bug report).

### D.4 Monetization

| Tier | Offer | Price intuition | Notes |
|---|---|---|---|
| Free | BYO‑key, full agent core, OSS | $0 | Adoption + trust; never gate safety |
| Pro | Hosted proxy: streaming, server‑side injection filtering, sync, no‑key setup, priority models | ~$8–15/mo | Convenience + safety value, not access |
| Teams/Enterprise | Policy controls, allowlist management, audit export, SSO, support | $/seat or contract | Where money actually is, if anywhere |
| Services | Setup/integration/support, sponsorships | opportunistic | Matches current STRATEGY.md |

**Rule (inherited and correct):** never cripple the free OSS core. Charge for **convenience, hosting, policy, and support** — never for **access or safety**.

### D.5 Existential risks (the ones that actually kill it)

1. **Anthropic API/ToS exposure.** Building an *agent* on top of someone else's API invites questions about acceptable use, automation, and reselling (especially a hosted proxy). BYO‑key reduces this (user is the customer) but doesn't eliminate it. **Mitigation:** read Anthropic's commercial/usage terms carefully, keep BYO‑key as the default, be multi‑provider, stay non‑abusive, and don't market "unlimited Claude." This is a *legal/relationship* risk, not a code risk.
2. **First‑parties eat the category.** Anthropic ships Claude‑for‑Chrome broadly (incl. Arc), or Arc/Brave bake in their own agent, or OpenAI/Perplexity win the browser. Your reason to exist shrinks. **Mitigation:** stay where they're slow (Chromium variants, BYO‑key, open/trusted), and treat the window as finite — don't over‑invest in a fortress.
3. **Store policy risk.** `<all_urls>` + `chrome.debugger` + "AI that controls your browser" is precisely the profile reviewers scrutinize (and sometimes reject) for remote‑code / over‑permission / user‑safety reasons. A takedown removes your distribution overnight. **Mitigation:** least‑privilege manifest, optional permissions, no remote code, crystal‑clear disclosures, and keep a load‑unpacked/self‑host path (the patcher already normalizes this).
4. **Liability of a controlling agent.** A prompt‑injection incident that drains an account or leaks data is a brand‑ending event for a *trust* brand. **Mitigation:** the read‑first, copilot‑default, sensitive‑domain‑blocked posture in §B — and the discipline to ship scope you can actually defend.

### D.6 Phased plan

| Phase | Scope | Goal | Gate to proceed |
|---|---|---|---|
| **0 (now)** | Keep & grow the patcher; ship security/threat content; build audience | Trust + funnel | Already underway |
| **1** | **Chromium‑only**, BYO‑key, **read‑first + copilot** agent; least‑privilege; OSS core; CWS listing (covers Arc) | Prove value + safety with existing audience | Demand signal + a safety layer you'd personally trust |
| **2** | Firefox port (sidebar_action, `browser.*`, DOM‑control fallback); optional Pro proxy | Reach + first revenue | Phase‑1 traction + Firefox demand |
| **3** | Safari (Xcode/App Store) **only if** real pull; Teams/Enterprise policy features | Monetization breadth | Clear paying demand (don't pre‑build) |

### D.7 What would make me NOT do it

- You can't commit to **ongoing security ownership** (then ship a *read‑only* assistant instead, or stay on the patcher).
- Anthropic signals it's **shipping broad multi‑browser support imminently** (the wedge closes).
- Anthropic's **API terms** clearly disallow third‑party agentic wrappers (then BYO‑key‑only, or reconsider).
- The first Chromium MVP shows users **won't grant the permissions** an agent needs (then the category isn't ready for your audience).
- It would require **gating safety or core access** to be viable (violates the trust thesis that is the whole moat).

---

## Final recommendation

**Build it — narrowly, safely, and on the back of the patcher.** Specifically:

1. **Phase 0:** Keep the patcher as the trust engine and distribution channel. (No change to current plan.)
2. **Phase 1:** Ship a **Chromium‑only, BYO‑key, read‑first, copilot‑default** Claude agent whose *brand is safety and honesty*, targeting the Arc/Reddit audience you already own. One CWS listing reaches every Chromium browser including Arc — that's your "cross‑browser" win for ~free.
3. **Reframe the thesis:** the wedge is **trust + the underserved Chromium‑variant audience**, *not* "works on all browsers." Firefox and Safari are demand‑gated ports, not the strategy. Portability is a treadmill; trust is the moat.
4. **Treat the safety layer as the product**, accept that "totally safe" is impossible, and sell "safe enough to trust for a defined scope."
5. **Watch the three killers** (Anthropic ToS, first‑party encroachment, store policy) and keep the investment proportional to a *finite* window.

If you're not willing to own the security posture indefinitely, **don't ship a controlling agent** — ship a read‑only assistant or stay with the patcher. The engineering is the easy 20%; the trust and safety are the 80% that determine whether this is a credible product or a liability.

---

*Audit only. No implementation performed. No files modified outside `research/`.*
