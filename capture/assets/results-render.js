// Shared render functions for the live /capture results page AND the
// permanent /capture/results/{slug} page. Both pages share the same DOM
// element IDs so these functions Just Work on either.
//
// Public surface (via window.CaptureRender):
//   renderResults({ results, profile, notionUrl, resultsUrl, emailSent })
//   updateActionBar(state)
//   renderMap(results)
//   escapeHtml(s)
//
// No external dependencies. Keep it tight.

(function () {
  const $ = (id) => document.getElementById(id);

  function escapeHtml(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    })[c]);
  }

  // ============================================================
  // Top-level orchestrator
  // ============================================================
  function renderResults(state) {
    const r = state && state.results;
    if (!r) return;
    const p = state.profile || {};

    // Hero
    const biz = [p.businessName, p.processName].filter(Boolean).join(" · ");
    if ($("resultsBiz"))     $("resultsBiz").textContent = biz;
    if ($("resultsTitle"))   $("resultsTitle").textContent = r.sop_title || (p.processName + " SOP");
    if ($("resultsSummary")) $("resultsSummary").textContent = r.process_summary || "";

    updateActionBar(state);
    renderExecSummary(r);
    renderImpact(r);
    renderStartHere(r);
    renderMap(r);
    renderOpportunities(r);
    renderBottlenecks(r);
    renderCollapsedSections(r);
  }

  // ============================================================
  // Action bar
  // ============================================================
  function updateActionBar(state) {
    const notionUrl  = state.notionUrl || null;
    const resultsUrl = state.resultsUrl || null;

    if ($("notionOpenBtn") && $("notionBtn")) {
      if (notionUrl) {
        $("notionOpenBtn").hidden = false;
        $("notionOpenBtn").href = notionUrl;
        $("notionBtn").hidden = true;
      } else {
        $("notionOpenBtn").hidden = true;
        $("notionBtn").hidden = false;
      }
    }

    // Permanent URL row. On the live /capture page this includes the
    // big "Open Results" button (openResultsBtn). On the permanent
    // /capture/results/{slug} page that button doesn't exist (you're
    // already there), so we guard every element individually.
    if ($("resultsUrlRow")) {
      if (resultsUrl) {
        $("resultsUrlRow").hidden = false;
        if ($("resultsUrlField")) $("resultsUrlField").value = resultsUrl;
        if ($("openResultsBtn"))  $("openResultsBtn").href = resultsUrl;
      } else {
        $("resultsUrlRow").hidden = true;
      }
    }

    // Email status chip
    const es = $("emailStatus");
    if (es) {
      if (state.emailSent === true) {
        es.hidden = false;
        es.classList.remove("fail");
        const name = (state.profile && state.profile.firstName) || "you";
        const text = $("emailStatusText");
        if (text) text.textContent = "Sent to " + name + " and Joe";
      } else if (state.emailSent === false) {
        es.hidden = false;
        es.classList.add("fail");
        const text = $("emailStatusText");
        if (text) text.textContent = "Email did not send. Your results are still saved.";
      } else {
        es.hidden = true;
      }
    }
  }

  // ============================================================
  // Executive summary
  // ============================================================
  function renderExecSummary(r) {
    const e = (r && r.executive_summary) || {};
    const setCell = (id, value) => {
      const el = $(id);
      if (!el) return;
      if (!value) { el.hidden = true; return; }
      el.hidden = false;
      const text = el.querySelector(".exec-cell-text");
      if (text) text.textContent = value;
    };
    setCell("execBottleneck", e.biggest_bottleneck);
    setCell("execTimeDrain",  e.biggest_time_drain);
    setCell("execOwner",      e.most_owner_dependent_step);
    setCell("execAi",         e.most_immediate_ai_opportunity);
    const any = e.biggest_bottleneck || e.biggest_time_drain || e.most_owner_dependent_step || e.most_immediate_ai_opportunity;
    if ($("execSection")) $("execSection").hidden = !any;
  }

  // ============================================================
  // Estimated operational impact (new high-level block)
  // ============================================================
  function renderImpact(r) {
    const section = $("impactSection");
    const list = $("impactList");
    if (!section || !list) return;
    const items = Array.isArray(r.estimated_operational_impact) ? r.estimated_operational_impact.slice(0, 5) : [];
    if (!items.length) { section.hidden = true; return; }
    section.hidden = false;
    list.innerHTML = items.map((i) =>
      '<div class="impact-row"><span class="impact-tick">✓</span><span>' + escapeHtml(i) + "</span></div>"
    ).join("");
  }

  // ============================================================
  // Start Here
  // ============================================================
  function renderStartHere(r) {
    const sec = $("startHereSection");
    if (!sec) return;
    const fb = r && r.recommended_first_build;
    if (!fb || !fb.title) { sec.hidden = true; return; }
    sec.hidden = false;
    $("startHereTitle").textContent = fb.title;
    $("startHereWhy").textContent = fb.why_this_first || "";
    $("startHereWhat").textContent = fb.what_practical_ai_would_build || "";
    const impactEl = $("startHereImpact");
    if (impactEl) {
      impactEl.innerHTML = "";
      if (Array.isArray(fb.estimated_impact)) {
        fb.estimated_impact.slice(0, 4).forEach((i) => {
          const c = document.createElement("div");
          c.className = "impact-chip";
          c.textContent = i;
          impactEl.appendChild(c);
        });
      }
    }
  }

  // ============================================================
  // AI Opportunities
  // ============================================================
  function renderOpportunities(r) {
    const sec  = $("opportunitiesSection");
    const list = $("opportunitiesList");
    if (!sec || !list) return;
    const ideas = Array.isArray(r.automation_ideas) ? r.automation_ideas : [];
    if (!ideas.length) { sec.hidden = true; return; }
    sec.hidden = false;
    list.innerHTML = ideas.map((a) => {
      const diffClass = a.difficulty ? ("diff-" + a.difficulty) : "";
      const impactHtml = Array.isArray(a.estimated_impact) && a.estimated_impact.length
        ? '<div class="impact-list">' + a.estimated_impact.slice(0, 4).map((i) =>
            '<div class="impact-chip">' + escapeHtml(i) + "</div>").join("") + "</div>"
        : "";
      const detail = '<details class="step-detail">'
        + "<summary>Tell me more</summary>"
        + '<div class="step-detail-body">'
        + (a.plain_english_description ? "<p>" + escapeHtml(a.plain_english_description) + "</p>" : "")
        + (a.why_it_matters ? '<p><span class="label">Why it matters:</span>' + escapeHtml(a.why_it_matters) + "</p>" : "")
        + (a.practical_ai_build_note ? '<p><span class="label">We would build:</span>' + escapeHtml(a.practical_ai_build_note) + "</p>" : "")
        + (a.recommended_process_step ? '<p><span class="label">Connects to:</span>' + escapeHtml(a.recommended_process_step) + "</p>" : "")
        + "</div></details>";
      return '<article class="opp">'
        + '<div class="opp-head">'
        + (a.difficulty ? '<span class="pill ' + diffClass + '">' + escapeHtml(a.difficulty) + "</span>" : "")
        + "<h3>" + escapeHtml(a.title || "") + "</h3>"
        + "</div>"
        + impactHtml
        + detail
        + "</article>";
    }).join("");
  }

  // ============================================================
  // Bottlenecks
  // ============================================================
  function renderBottlenecks(r) {
    const sec  = $("bottlenecksSection");
    const list = $("bottlenecksList");
    if (!sec || !list) return;
    const items = Array.isArray(r.bottlenecks) ? r.bottlenecks : [];
    if (!items.length) { sec.hidden = true; return; }
    sec.hidden = false;
    list.innerHTML = items.map((b) => {
      const oneLine = b.description || b.why_it_matters || "";
      const hasMore = b.description && b.why_it_matters;
      return '<article class="bottleneck">'
        + "<h3>" + escapeHtml(b.title || "") + "</h3>"
        + (oneLine ? '<p class="one-line">' + escapeHtml(oneLine) + "</p>" : "")
        + (hasMore
            ? '<details class="step-detail"><summary>More</summary><div class="step-detail-body"><p><span class="label">Why it matters:</span>' + escapeHtml(b.why_it_matters) + "</p></div></details>"
            : "")
        + "</article>";
    }).join("");
  }

  // ============================================================
  // Process map (pills for people/tools, details collapsed)
  // ============================================================
  function splitToList(s) {
    return String(s || "").split(/[,;•]+/).map((x) => x.trim()).filter(Boolean);
  }

  function renderMap(r) {
    const view = $("mapView");
    if (!view) return;
    view.innerHTML = "";
    const steps = Array.isArray(r.process_steps) ? r.process_steps : [];
    const branches = Array.isArray(r.process_branches) ? r.process_branches : [];

    const branchMap = {};
    branches.forEach((b) => {
      const key = String(b.after_step || "");
      if (!branchMap[key]) branchMap[key] = [];
      branchMap[key].push(b);
    });

    const ideas = Array.isArray(r.automation_ideas) ? r.automation_ideas : [];
    function findAutomationFor(step) {
      const key = String(step.step_number);
      const title = (step.title || "").toLowerCase();
      for (const a of ideas) {
        const ref = String(a.recommended_process_step || "").toLowerCase();
        if (ref === key) return a;
        if (ref && title && ref.includes(title.slice(0, 12))) return a;
        if (ref && ref.includes("step " + key)) return a;
      }
      return null;
    }

    steps.forEach((s) => {
      const stepEl = document.createElement("div");
      stepEl.className = "map-step" + (s.automation_opportunity ? " has-auto" : "");
      stepEl.innerHTML = '<div class="map-step-num">' + escapeHtml(String(s.step_number || "")) + "</div>";

      const card = document.createElement("div");
      card.className = "map-step-card";

      // Merge point inputs
      if (Array.isArray(s.inputs_from) && s.inputs_from.length) {
        card.innerHTML += '<div class="map-inputs"><div class="map-inputs-label">Inputs from</div>'
          + '<div class="map-inputs-items">'
          + s.inputs_from.map((i) => "<span>" + escapeHtml(i) + "</span>").join("")
          + "</div></div>";
      }

      // Title
      card.innerHTML += '<div class="map-step-title">' + escapeHtml(s.title || "") + "</div>";

      // People + tools as pills (replaces the old comma-joined line for scannability)
      const peoplePills = splitToList(s.people_involved).map((x) =>
        '<span class="map-pill person">' + escapeHtml(x) + "</span>").join("");
      const toolPills   = splitToList(s.tools_used).map((x) =>
        '<span class="map-pill tool">' + escapeHtml(x) + "</span>").join("");
      if (peoplePills || toolPills) {
        card.innerHTML += '<div class="map-pill-row">' + peoplePills + toolPills + "</div>";
      }

      // Friction (one line, prominent)
      if (s.risk_or_friction) {
        card.innerHTML += '<div class="map-step-friction">' + escapeHtml(s.risk_or_friction) + "</div>";
      }

      // Automation chip
      if (s.automation_opportunity) {
        const idea = findAutomationFor(s);
        const label = idea ? idea.title : "Automation opportunity";
        card.innerHTML += '<div class="automation-chip">'
          + '<svg class="logo"><use href="#repeat-logo-symbol"></use></svg>'
          + '<div class="text"><b>Where AI can help</b>' + escapeHtml(label) + "</div>"
          + "</div>";
      }

      // Collapsed details (description only — tools are already pills)
      if (s.description) {
        card.innerHTML += '<details class="step-detail">'
          + "<summary>View details</summary>"
          + '<div class="step-detail-body">'
          + "<p>" + escapeHtml(s.description) + "</p>"
          + "</div>"
          + "</details>";
      }

      stepEl.appendChild(card);
      view.appendChild(stepEl);

      // Branch after this step?
      const after = branchMap[String(s.step_number)];
      if (after) {
        after.forEach((b) => {
          const br = document.createElement("div");
          br.className = "branch";
          br.innerHTML = '<div class="branch-label">Decision</div>'
            + '<div class="branch-question">' + escapeHtml(b.condition || "") + "</div>"
            + '<div class="branch-paths">'
            +   '<div class="branch-path yes"><div class="branch-path-label">If yes</div><div class="branch-path-text">' + escapeHtml(b.yes_path || "") + "</div></div>"
            +   '<div class="branch-path no"><div class="branch-path-label">If no</div><div class="branch-path-text">' + escapeHtml(b.no_path || "") + "</div></div>"
            + "</div>";
          view.appendChild(br);
        });
      }
    });
  }

  // ============================================================
  // Collapsed supporting detail sections
  // ============================================================
  function renderCollapsed(detailsId, listId, countId, items, itemFn) {
    const wrap = $(detailsId);
    if (!wrap) return;
    if (!Array.isArray(items) || !items.length) return;
    wrap.hidden = false;
    if ($(countId)) $(countId).textContent = items.length + " item" + (items.length === 1 ? "" : "s");
    if ($(listId))  $(listId).innerHTML = items.map((x) => '<div class="mini-card">' + itemFn(x) + "</div>").join("");
  }

  function renderCollapsedSections(r) {
    renderCollapsed("toolsDetails", "toolsList", "toolsCount", r.tools_and_systems, (t) => {
      const pills = [];
      if (t.system_role) pills.push('<span class="pill">' + escapeHtml(t.system_role.replace(/_/g, " ")) + "</span>");
      const meta = [];
      if (t.used_by)     meta.push("<div><b>Used by:</b> " + escapeHtml(t.used_by) + "</div>");
      if (t.pain_points) meta.push("<div><b>Pain points:</b> " + escapeHtml(t.pain_points) + "</div>");
      return "<h4>" + escapeHtml(t.tool_name || "") + "</h4>"
        + pills.join("")
        + (t.purpose ? "<p>" + escapeHtml(t.purpose) + "</p>" : "")
        + (meta.length ? '<div class="meta">' + meta.join("") + "</div>" : "");
    });
    renderCollapsed("breakdownDetails", "breakdownList", "breakdownCount", r.systems_breakdown, (b) =>
      "<h4>" + escapeHtml(b.title || "") + "</h4>"
      + (b.description ? "<p>" + escapeHtml(b.description) + "</p>" : "")
      + (b.impact ? '<div class="meta"><b>Impact:</b> ' + escapeHtml(b.impact) + "</div>" : "")
    );
    renderCollapsed("ownerDetails", "ownerList", "ownerCount", r.owner_dependencies, (d) =>
      "<h4>" + escapeHtml(d.title || "") + "</h4>"
      + (d.description ? "<p>" + escapeHtml(d.description) + "</p>" : "")
    );
    renderCollapsed("manualDetails", "manualList", "manualCount", r.manual_work, (m) =>
      "<h4>" + escapeHtml(m.title || "") + "</h4>"
      + (m.description ? "<p>" + escapeHtml(m.description) + "</p>" : "")
    );
    if (Array.isArray(r.sop_sections) && r.sop_sections.length && $("sopDetails")) {
      $("sopDetails").hidden = false;
      if ($("sopTitleLabel")) $("sopTitleLabel").textContent = r.sop_title || "Full SOP";
      if ($("sopCount"))      $("sopCount").textContent = r.sop_sections.length + " section" + (r.sop_sections.length === 1 ? "" : "s");
      if ($("sopBody"))       $("sopBody").innerHTML = r.sop_sections.map((s) =>
        '<div class="sop-block">'
        + "<h4>" + escapeHtml(s.section_title || "") + "</h4>"
        + (s.content ? "<p>" + escapeHtml(s.content).replace(/\n/g, "<br/>") + "</p>" : "")
        + "</div>"
      ).join("");
    }
  }

  // ============================================================
  // Export
  // ============================================================
  window.CaptureRender = {
    renderResults,
    updateActionBar,
    renderMap,
    escapeHtml,
  };
})();
