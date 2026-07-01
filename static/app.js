const HOSTS_VIEW = "__hosts__";

const state = {
  topTab: "files", // "files" | "ops"
  inventory: null,
  files: [],
  currentPath: null,
  entries: [],
  raw: "",
  pending: {}, // key -> {enabled, value}
  rawMode: false,
  hosts: [],
  hostsRaw: "",
  hostsMode: "form",
  hostsDirty: false,
  opsInvArg: "",
  opsMode: "add",
  opsFields: {
    add: { role: "worker", nodeNames: "", refreshFacts: true, etcdRetries: "" },
    remove: { nodeName: "", offline: false },
    reset: { scope: "cluster", nodeNames: "", skipConfirm: false },
    scale: { nodeNames: "", refreshFacts: true },
    backup: { preset: "daily", customSchedule: "", retentionCount: "", backupDir: "" },
  },
};

const el = (sel) => document.querySelector(sel);
const invSelect = el("#invSelect");
const sidebar = el("#sidebar");
const content = el("#content");
const searchInput = el("#searchInput");
const searchResults = el("#searchResults");
const toast = el("#toast");

const GROUP_LABELS = {
  control_plane: "Control Plane",
  etcd: "etcd",
  node: "Worker Node",
  calico_rr: "Calico RR",
  bastion: "Bastion",
};

function showToast(msg, kind) {
  toast.textContent = msg;
  toast.className = "toast " + (kind || "");
  setTimeout(() => { toast.className = "toast hidden"; }, 3500);
}

async function api(path, opts) {
  const res = await fetch(path, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.detail || res.statusText);
  }
  return data;
}

async function init() {
  await loadInventories();
  invSelect.addEventListener("change", () => selectInventory(invSelect.value));
  el("#newInvBtn").addEventListener("click", createInventory);
  el("#deleteInvBtn").addEventListener("click", deleteInventory);
  el("#filesTabBtn").addEventListener("click", () => switchTab("files"));
  el("#opsTabBtn").addEventListener("click", () => switchTab("ops"));
  searchInput.addEventListener("input", debounce(onSearch, 250));
  document.addEventListener("click", (e) => {
    if (!searchResults.contains(e.target) && e.target !== searchInput) {
      searchResults.classList.add("hidden");
    }
  });
}

async function switchTab(tab) {
  if (tab === state.topTab) {
    el("#filesTabBtn").classList.toggle("active", tab === "files");
    el("#opsTabBtn").classList.toggle("active", tab === "ops");
    return;
  }
  if (state.topTab === "files" && hasUnsavedChanges()) {
    if (!confirm("You have unsaved changes on the current view. Discard them?")) return;
  }
  state.topTab = tab;
  el("#filesTabBtn").classList.toggle("active", tab === "files");
  el("#opsTabBtn").classList.toggle("active", tab === "ops");
  sidebar.classList.toggle("hidden-tab", tab === "ops");
  if (tab === "ops") {
    await loadOps();
  } else {
    renderSidebar();
    if (state.currentPath === HOSTS_VIEW) {
      renderHosts();
    } else if (state.currentPath) {
      renderFile();
    } else {
      content.innerHTML = `<div class="empty-state"><p>Select a file from the sidebar to edit its variables.</p></div>`;
    }
  }
}

async function loadOps() {
  const data = await api(`/api/inventories/${state.inventory}/ops-context`);
  state.opsInvArg = data.inventory_arg;
  renderOps();
}

function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

async function loadInventories() {
  const data = await api("/api/inventories");
  invSelect.innerHTML = "";
  for (const name of data.inventories) {
    const opt = document.createElement("option");
    opt.value = name; opt.textContent = name;
    invSelect.appendChild(opt);
  }
  const preferred = data.inventories.find((n) => n !== "sample") || data.inventories[0];
  if (preferred) {
    invSelect.value = preferred;
    await selectInventory(preferred);
  }
}

async function createInventory() {
  const name = prompt("New inventory name (letters, numbers, - or _):");
  if (!name) return;
  try {
    await api("/api/inventories", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, clone_from: state.inventory || "sample" }),
    });
    await loadInventories();
    invSelect.value = name;
    await selectInventory(name);
    showToast(`Inventory "${name}" created from ${state.inventory || "sample"}.`, "success");
  } catch (e) {
    showToast("Error: " + e.message, "error");
  }
}

async function deleteInventory() {
  const name = state.inventory;
  if (!name) return;
  if (name === "sample") {
    showToast("The built-in 'sample' inventory cannot be deleted.", "error");
    return;
  }
  if (!confirm(`Delete inventory "${name}" and all its group_vars / hosts permanently? This cannot be undone.`)) return;
  try {
    await api(`/api/inventories/${name}`, { method: "DELETE" });
    showToast(`Inventory "${name}" deleted.`, "success");
    await loadInventories();
  } catch (e) {
    showToast("Error: " + e.message, "error");
  }
}

async function selectInventory(name) {
  state.inventory = name;
  state.currentPath = null;
  const data = await api(`/api/inventories/${name}/files`);
  state.files = data.files;
  if (state.topTab === "ops") {
    await loadOps();
  } else {
    content.innerHTML = `<div class="empty-state"><p>Select a file from the sidebar to edit its variables.</p></div>`;
    renderSidebar();
  }
}

function renderSidebar() {
  sidebar.innerHTML = "";

  const hostsItem = document.createElement("div");
  hostsItem.className = "file-item hosts-nav-item" + (state.currentPath === HOSTS_VIEW ? " active" : "");
  hostsItem.innerHTML = `<span class="title">🖧 Hosts &amp; Inventory</span><span class="path">inventory.yml</span>`;
  hostsItem.addEventListener("click", () => selectHosts());
  sidebar.appendChild(hostsItem);

  const groups = {};
  for (const f of state.files) {
    (groups[f.group] ||= []).push(f);
  }
  for (const [group, files] of Object.entries(groups)) {
    const h = document.createElement("div");
    h.className = "group-title";
    h.textContent = group;
    sidebar.appendChild(h);
    for (const f of files) {
      const item = document.createElement("div");
      item.className = "file-item" + (f.exists ? "" : " missing") + (f.path === state.currentPath ? " active" : "");
      item.innerHTML = `
        <span class="title">${f.title}</span>
        <span class="path">${f.path}</span>
        ${f.exists ? "" : '<span class="badge">not present</span>'}
      `;
      item.addEventListener("click", () => selectFile(f.path));
      sidebar.appendChild(item);
    }
  }
}

function hasUnsavedChanges() {
  if (state.currentPath === HOSTS_VIEW) return state.hostsDirty;
  return Object.keys(state.pending).length > 0;
}

async function selectFile(path) {
  if (hasUnsavedChanges()) {
    if (!confirm("You have unsaved changes on the current view. Discard them?")) return;
  }
  state.currentPath = path;
  state.pending = {};
  state.rawMode = false;
  renderSidebar();
  const data = await api(`/api/inventories/${state.inventory}/files/${path}`);
  state.entries = data.entries;
  state.raw = data.raw;
  renderFile();
}

async function selectHosts() {
  if (hasUnsavedChanges()) {
    if (!confirm("You have unsaved changes on the current view. Discard them?")) return;
  }
  state.currentPath = HOSTS_VIEW;
  state.hostsMode = "form";
  state.hostsDirty = false;
  renderSidebar();
  const data = await api(`/api/inventories/${state.inventory}/hosts`);
  state.hosts = data.hosts;
  state.hostsRaw = data.raw;
  renderHosts();
}

function fileMeta(path) {
  return state.files.find((f) => f.path === path) || {};
}

function renderFile() {
  const meta = fileMeta(state.currentPath);
  const wrap = document.createElement("div");

  const header = document.createElement("div");
  header.className = "file-header";
  header.innerHTML = `<h2>${meta.title || state.currentPath}</h2><span class="path">${state.currentPath}</span>`;
  wrap.appendChild(header);

  if (meta.description) {
    const desc = document.createElement("div");
    desc.className = "file-desc";
    desc.textContent = meta.description;
    wrap.appendChild(desc);
  }

  const toolbar = document.createElement("div");
  toolbar.className = "toolbar";
  toolbar.innerHTML = `
    <button id="saveBtn" class="btn-primary">Save changes</button>
    <span id="dirtyIndicator" class="dirty-indicator"></span>
    <span class="spacer"></span>
    <button id="rawToggleBtn" class="btn-secondary raw-toggle">${state.rawMode ? "Form view" : "Raw YAML"}</button>
  `;
  wrap.appendChild(toolbar);

  const body = document.createElement("div");
  body.id = "fileBody";
  wrap.appendChild(body);

  content.innerHTML = "";
  content.appendChild(wrap);

  el("#saveBtn").addEventListener("click", state.rawMode ? saveRaw : saveForm);
  el("#rawToggleBtn").addEventListener("click", toggleRawMode);

  if (state.rawMode) {
    renderRaw(body);
  } else {
    renderForm(body);
  }
  updateDirtyIndicator();
}

function toggleRawMode() {
  state.rawMode = !state.rawMode;
  if (Object.keys(state.pending).length > 0) {
    showToast("Switched view. Unsaved form edits were kept in memory only if you already saved them.", "");
  }
  renderFile();
}

function updateDirtyIndicator() {
  const n = Object.keys(state.pending).length;
  el("#dirtyIndicator").textContent = n > 0 ? `${n} unsaved change(s)` : "";
}

function renderForm(body) {
  for (const entry of state.entries) {
    body.appendChild(renderVarRow(entry));
  }
}

// ---------- Hosts & Inventory (inventory.yml) ----------

function blankHost() {
  return {
    name: "", ansible_host: "", ip: "", access_ip: "", ansible_port: "", ansible_user: "",
    control_plane: false, etcd: false, node: false, calico_rr: false, bastion: false,
  };
}

function renderHosts() {
  const wrap = document.createElement("div");

  const header = document.createElement("div");
  header.className = "file-header";
  header.innerHTML = `<h2>Hosts &amp; Inventory</h2><span class="path">inventory.yml</span>`;
  wrap.appendChild(header);

  const desc = document.createElement("div");
  desc.className = "file-desc";
  desc.textContent = "Define the machines in this cluster and which groups they belong to (control plane, etcd, worker node, etc). Saving regenerates inventory.yml from scratch.";
  wrap.appendChild(desc);

  const toolbar = document.createElement("div");
  toolbar.className = "toolbar";
  toolbar.innerHTML = `
    <button id="addHostBtn" class="btn-secondary">+ Add host</button>
    <button id="saveHostsBtn" class="btn-primary">Save changes</button>
    <span id="dirtyIndicator" class="dirty-indicator"></span>
    <span class="spacer"></span>
    <button id="hostsRawToggleBtn" class="btn-secondary raw-toggle">${state.hostsMode === "raw" ? "Form view" : "Raw YAML"}</button>
  `;
  wrap.appendChild(toolbar);

  const body = document.createElement("div");
  body.id = "hostsBody";
  wrap.appendChild(body);

  content.innerHTML = "";
  content.appendChild(wrap);

  el("#addHostBtn").addEventListener("click", () => {
    state.hosts.push(blankHost());
    state.hostsDirty = true;
    renderHosts();
  });
  el("#saveHostsBtn").addEventListener("click", state.hostsMode === "raw" ? saveHostsRaw : saveHostsForm);
  el("#hostsRawToggleBtn").addEventListener("click", () => {
    state.hostsMode = state.hostsMode === "raw" ? "form" : "raw";
    renderHosts();
  });

  if (state.hostsMode === "raw") {
    const ta = document.createElement("textarea");
    ta.className = "raw-editor";
    ta.id = "hostsRawTextarea";
    ta.spellcheck = false;
    ta.value = state.hostsRaw;
    ta.addEventListener("input", () => { state.hostsDirty = true; updateHostsDirtyIndicator(); });
    body.appendChild(ta);
  } else {
    if (state.hosts.length === 0) {
      const empty = document.createElement("div");
      empty.className = "empty-state";
      empty.innerHTML = `<p>No hosts yet. Click "+ Add host" to define your first node.</p>`;
      body.appendChild(empty);
    }
    state.hosts.forEach((host, idx) => body.appendChild(renderHostCard(host, idx)));
  }
  updateHostsDirtyIndicator();
}

function renderHostCard(host, idx) {
  const card = document.createElement("div");
  card.className = "host-card";

  const headerRow = document.createElement("div");
  headerRow.className = "host-card-header";
  const nameInput = document.createElement("input");
  nameInput.type = "text";
  nameInput.placeholder = "host name (e.g. node1)";
  nameInput.className = "host-name-input";
  nameInput.value = host.name;
  nameInput.spellcheck = false;
  nameInput.addEventListener("input", () => { host.name = nameInput.value; state.hostsDirty = true; updateHostsDirtyIndicator(); });
  const delBtn = document.createElement("button");
  delBtn.className = "btn-danger";
  delBtn.textContent = "Remove";
  delBtn.addEventListener("click", () => {
    state.hosts.splice(idx, 1);
    state.hostsDirty = true;
    renderHosts();
  });
  headerRow.appendChild(nameInput);
  headerRow.appendChild(delBtn);
  card.appendChild(headerRow);

  const fields = document.createElement("div");
  fields.className = "host-fields";
  const fieldDefs = [
    ["ansible_host", "ansible_host (SSH address)"],
    ["ip", "ip (internal cluster IP)"],
    ["ansible_port", "ansible_port"],
    ["ansible_user", "ansible_user"],
  ];
  for (const [field, placeholder] of fieldDefs) {
    const input = document.createElement("input");
    input.type = "text";
    input.placeholder = placeholder;
    input.value = host[field] || "";
    input.spellcheck = false;
    input.addEventListener("input", () => { host[field] = input.value; state.hostsDirty = true; updateHostsDirtyIndicator(); });
    fields.appendChild(input);
  }
  card.appendChild(fields);

  const groups = document.createElement("div");
  groups.className = "host-groups";
  for (const [field, label] of Object.entries(GROUP_LABELS)) {
    const chip = document.createElement("label");
    chip.className = "group-chip";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = !!host[field];
    cb.addEventListener("change", () => { host[field] = cb.checked; state.hostsDirty = true; updateHostsDirtyIndicator(); });
    chip.appendChild(cb);
    chip.appendChild(document.createTextNode(" " + label));
    groups.appendChild(chip);
  }
  card.appendChild(groups);

  return card;
}

function updateHostsDirtyIndicator() {
  const indicator = el("#dirtyIndicator");
  if (indicator) indicator.textContent = state.hostsDirty ? "unsaved changes" : "";
}

async function saveHostsForm() {
  try {
    const data = await api(`/api/inventories/${state.inventory}/hosts`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ hosts: state.hosts }),
    });
    state.hosts = data.hosts;
    state.hostsRaw = data.raw;
    state.hostsDirty = false;
    renderHosts();
    showToast("Saved.", "success");
  } catch (e) {
    showToast("Error: " + e.message, "error");
  }
}

async function saveHostsRaw() {
  const ta = el("#hostsRawTextarea");
  try {
    const data = await api(`/api/inventories/${state.inventory}/hosts/raw`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: ta.value }),
    });
    state.hosts = data.hosts;
    state.hostsRaw = data.raw;
    state.hostsDirty = false;
    renderHosts();
    showToast("Saved.", "success");
  } catch (e) {
    showToast("Error: " + e.message, "error");
  }
}

// ---------- Cluster Operations (command builder) ----------

const OPS_TABS = [
  { key: "add", label: "Add node" },
  { key: "remove", label: "Remove node" },
  { key: "reset", label: "Reset" },
  { key: "scale", label: "Scale" },
  { key: "backup", label: "Backup etcd" },
];

const BACKUP_SCHEDULE_PRESETS = {
  daily: "*-*-* 03:00:00",
  every6h: "*-*-* 0/6:00:00",
  every12h: "*-*-* 0/12:00:00",
  weekly: "weekly",
};

function limitList(text) {
  return (text || "").split(/[\s,]+/).filter(Boolean).join(":");
}

function buildOpsCommands() {
  const inv = state.opsInvArg || "inventory/<name>/inventory.ini";
  const f = state.opsFields[state.opsMode];
  const lines = [];

  if (state.opsMode === "add") {
    if (f.role === "worker") {
      if (f.refreshFacts) lines.push(`ansible-playbook -i ${inv} facts.yml -b -v`);
      const limit = limitList(f.nodeNames);
      lines.push(`ansible-playbook -i ${inv} scale.yml -b -v` + (limit ? ` --limit=${limit}` : ""));
    } else if (f.role === "control_plane") {
      lines.push(`ansible-playbook -i ${inv} cluster.yml -b -v --limit=kube_control_plane`);
    } else if (f.role === "etcd") {
      let cmd = `ansible-playbook -i ${inv} cluster.yml -b -v --limit=etcd,kube_control_plane -e ignore_assert_errors=yes`;
      if (f.etcdRetries) cmd += ` -e etcd_retries=${f.etcdRetries}`;
      lines.push(cmd);
    }
  } else if (state.opsMode === "remove") {
    let cmd = `ansible-playbook -i ${inv} remove-node.yml -b -v -e node=${f.nodeName || "NODE_NAME"}`;
    if (f.offline) cmd += ` -e reset_nodes=false -e allow_ungraceful_removal=true`;
    lines.push(cmd);
  } else if (state.opsMode === "reset") {
    let cmd = `ansible-playbook -i ${inv} reset.yml -b -v`;
    if (f.scope === "specific") {
      const limit = limitList(f.nodeNames);
      if (limit) cmd += ` --limit=${limit}`;
    }
    if (f.skipConfirm) cmd += ` -e reset_confirmation=yes`;
    lines.push(cmd);
  } else if (state.opsMode === "scale") {
    const limit = limitList(f.nodeNames);
    if (limit && f.refreshFacts) lines.push(`ansible-playbook -i ${inv} facts.yml -b -v`);
    lines.push(`ansible-playbook -i ${inv} scale.yml -b -v` + (limit ? ` --limit=${limit}` : ""));
  } else if (state.opsMode === "backup") {
    const schedule = f.preset === "custom" ? (f.customSchedule || "*-*-* 03:00:00") : BACKUP_SCHEDULE_PRESETS[f.preset];
    let cmd = `ansible-playbook -i ${inv} extra_playbooks/etcd-backup-schedule.yml -b -v -e etcd_backup_schedule="${schedule}"`;
    if (f.retentionCount !== "") cmd += ` -e etcd_backup_retention_count=${f.retentionCount}`;
    if (f.backupDir) cmd += ` -e etcd_backup_prefix=${f.backupDir}`;
    lines.push(cmd);
  }

  return lines.join("\n");
}

function updateOpsCommand() {
  const ta = el("#opsCommandOutput");
  if (ta) ta.value = buildOpsCommands();
}

function renderOps() {
  const wrap = document.createElement("div");

  const header = document.createElement("div");
  header.className = "file-header";
  header.innerHTML = `<h2>Cluster Operations</h2><span class="path">${state.opsInvArg || ""}</span>`;
  wrap.appendChild(header);

  const desc = document.createElement("div");
  desc.className = "file-desc";
  desc.textContent = "Builds the exact ansible-playbook command for common cluster operations. Nothing runs automatically — copy the command and run it yourself from the kubespray root directory.";
  wrap.appendChild(desc);

  const tabs = document.createElement("div");
  tabs.className = "ops-tabs";
  for (const t of OPS_TABS) {
    const btn = document.createElement("button");
    btn.className = "btn-secondary" + (state.opsMode === t.key ? " active" : "");
    btn.textContent = t.label;
    btn.addEventListener("click", () => { state.opsMode = t.key; renderOps(); });
    tabs.appendChild(btn);
  }
  wrap.appendChild(tabs);

  const fieldsWrap = document.createElement("div");
  fieldsWrap.className = "ops-fields";
  wrap.appendChild(fieldsWrap);
  renderOpsFields(fieldsWrap);

  const outLabel = document.createElement("div");
  outLabel.className = "ops-cmd-label";
  outLabel.textContent = "Command to run:";
  wrap.appendChild(outLabel);

  const outputRow = document.createElement("div");
  outputRow.className = "ops-cmd-row";
  const output = document.createElement("textarea");
  output.id = "opsCommandOutput";
  output.className = "raw-editor ops-cmd-output";
  output.readOnly = true;
  output.spellcheck = false;
  output.value = buildOpsCommands();
  const copyBtn = document.createElement("button");
  copyBtn.className = "btn-primary";
  copyBtn.textContent = "Copy";
  copyBtn.addEventListener("click", async () => {
    await navigator.clipboard.writeText(output.value);
    showToast("Command copied.", "success");
  });
  outputRow.appendChild(output);
  outputRow.appendChild(copyBtn);
  wrap.appendChild(outputRow);

  content.innerHTML = "";
  content.appendChild(wrap);
}

function opsField(labelText, inputEl) {
  const wrap = document.createElement("label");
  wrap.className = "ops-field";
  const span = document.createElement("span");
  span.textContent = labelText;
  wrap.appendChild(span);
  wrap.appendChild(inputEl);
  return wrap;
}

function renderOpsFields(body) {
  body.innerHTML = "";
  const f = state.opsFields[state.opsMode];

  if (state.opsMode === "add") {
    const roleSelect = document.createElement("select");
    for (const [value, label] of [["worker", "Worker node"], ["control_plane", "Control plane node"], ["etcd", "etcd node"]]) {
      const opt = document.createElement("option");
      opt.value = value; opt.textContent = label;
      if (f.role === value) opt.selected = true;
      roleSelect.appendChild(opt);
    }
    roleSelect.addEventListener("change", () => { f.role = roleSelect.value; renderOpsFields(body); updateOpsCommand(); });
    body.appendChild(opsField("Node role", roleSelect));

    if (f.role === "worker") {
      const namesInput = document.createElement("input");
      namesInput.type = "text";
      namesInput.placeholder = "node4,node5 (leave empty to run against the whole inventory)";
      namesInput.value = f.nodeNames;
      namesInput.addEventListener("input", () => { f.nodeNames = namesInput.value; updateOpsCommand(); });
      body.appendChild(opsField("New node name(s) (--limit)", namesInput));

      const refreshCb = document.createElement("input");
      refreshCb.type = "checkbox";
      refreshCb.checked = f.refreshFacts;
      refreshCb.addEventListener("change", () => { f.refreshFacts = refreshCb.checked; updateOpsCommand(); });
      body.appendChild(opsField("Refresh facts cache first (facts.yml, recommended with --limit)", refreshCb));

      const note = document.createElement("div");
      note.className = "ops-note";
      note.textContent = "Add the new host to the inventory's Hosts & Inventory tab before running this.";
      body.appendChild(note);
    } else if (f.role === "control_plane") {
      const note = document.createElement("div");
      note.className = "ops-note";
      note.textContent = "Append the new host to the end of the kube_control_plane group first — scale.yml cannot be used for control plane nodes. After this, restart nginx-proxy on every host.";
      body.appendChild(note);
    } else if (f.role === "etcd") {
      const retriesInput = document.createElement("input");
      retriesInput.type = "number";
      retriesInput.placeholder = "e.g. 10 when adding multiple etcd nodes at once";
      retriesInput.value = f.etcdRetries;
      retriesInput.addEventListener("input", () => { f.etcdRetries = retriesInput.value; updateOpsCommand(); });
      body.appendChild(opsField("etcd_retries (optional)", retriesInput));

      const note = document.createElement("div");
      note.className = "ops-note";
      note.textContent = "Keep an odd number of etcd nodes. If the new node is already a worker/control-plane node, remove it first with Remove Node.";
      body.appendChild(note);
    }
  } else if (state.opsMode === "remove") {
    const nameInput = document.createElement("input");
    nameInput.type = "text";
    nameInput.placeholder = "node-name";
    nameInput.value = f.nodeName;
    nameInput.addEventListener("input", () => { f.nodeName = nameInput.value; updateOpsCommand(); });
    body.appendChild(opsField("Node to remove (-e node=)", nameInput));

    const offlineCb = document.createElement("input");
    offlineCb.type = "checkbox";
    offlineCb.checked = f.offline;
    offlineCb.addEventListener("change", () => { f.offline = offlineCb.checked; updateOpsCommand(); });
    body.appendChild(opsField("Node is offline / unreachable (reset_nodes=false, allow_ungraceful_removal=true)", offlineCb));

    const note = document.createElement("div");
    note.className = "ops-note danger";
    note.textContent = "This removes the node from the running cluster. Remove it from the inventory's Hosts & Inventory tab afterwards.";
    body.appendChild(note);
  } else if (state.opsMode === "reset") {
    const scopeSelect = document.createElement("select");
    for (const [value, label] of [["cluster", "Entire cluster"], ["specific", "Specific node(s)"]]) {
      const opt = document.createElement("option");
      opt.value = value; opt.textContent = label;
      if (f.scope === value) opt.selected = true;
      scopeSelect.appendChild(opt);
    }
    scopeSelect.addEventListener("change", () => { f.scope = scopeSelect.value; renderOpsFields(body); updateOpsCommand(); });
    body.appendChild(opsField("Scope", scopeSelect));

    if (f.scope === "specific") {
      const namesInput = document.createElement("input");
      namesInput.type = "text";
      namesInput.placeholder = "node4,node5";
      namesInput.value = f.nodeNames;
      namesInput.addEventListener("input", () => { f.nodeNames = namesInput.value; updateOpsCommand(); });
      body.appendChild(opsField("Node name(s) (--limit)", namesInput));
    }

    const skipCb = document.createElement("input");
    skipCb.type = "checkbox";
    skipCb.checked = f.skipConfirm;
    skipCb.addEventListener("change", () => { f.skipConfirm = skipCb.checked; updateOpsCommand(); });
    body.appendChild(opsField("Skip the interactive \"yes\" confirmation prompt (-e reset_confirmation=yes)", skipCb));

    const note = document.createElement("div");
    note.className = "ops-note danger";
    note.textContent = "Destructive: this wipes Kubernetes/etcd/container-runtime state from the targeted hosts. Without the checkbox above, ansible-playbook will still ask you to type \"yes\" interactively.";
    body.appendChild(note);
  } else if (state.opsMode === "scale") {
    const namesInput = document.createElement("input");
    namesInput.type = "text";
    namesInput.placeholder = "node4,node5 (leave empty to scale the whole inventory)";
    namesInput.value = f.nodeNames;
    namesInput.addEventListener("input", () => { f.nodeNames = namesInput.value; updateOpsCommand(); });
    body.appendChild(opsField("Node name(s) (--limit)", namesInput));

    const refreshCb = document.createElement("input");
    refreshCb.type = "checkbox";
    refreshCb.checked = f.refreshFacts;
    refreshCb.addEventListener("change", () => { f.refreshFacts = refreshCb.checked; updateOpsCommand(); });
    body.appendChild(opsField("Refresh facts cache first (facts.yml, recommended with --limit)", refreshCb));

    const note = document.createElement("div");
    note.className = "ops-note";
    note.textContent = "scale.yml only adds/updates worker nodes; it will not add control plane or etcd members.";
    body.appendChild(note);
  } else if (state.opsMode === "backup") {
    const presetSelect = document.createElement("select");
    for (const [value, label] of [["daily", "Daily at 03:00"], ["every6h", "Every 6 hours"], ["every12h", "Every 12 hours"], ["weekly", "Weekly"], ["custom", "Custom (systemd OnCalendar)"]]) {
      const opt = document.createElement("option");
      opt.value = value; opt.textContent = label;
      if (f.preset === value) opt.selected = true;
      presetSelect.appendChild(opt);
    }
    presetSelect.addEventListener("change", () => { f.preset = presetSelect.value; renderOpsFields(body); updateOpsCommand(); });
    body.appendChild(opsField("Schedule", presetSelect));

    if (f.preset === "custom") {
      const scheduleInput = document.createElement("input");
      scheduleInput.type = "text";
      scheduleInput.placeholder = "e.g. *-*-* 03:00:00";
      scheduleInput.value = f.customSchedule;
      scheduleInput.addEventListener("input", () => { f.customSchedule = scheduleInput.value; updateOpsCommand(); });
      body.appendChild(opsField("OnCalendar expression", scheduleInput));
    }

    const retentionInput = document.createElement("input");
    retentionInput.type = "number";
    retentionInput.placeholder = "-1 = keep all (kubespray default)";
    retentionInput.value = f.retentionCount;
    retentionInput.addEventListener("input", () => { f.retentionCount = retentionInput.value; updateOpsCommand(); });
    body.appendChild(opsField("Snapshots to retain (optional)", retentionInput));

    const dirInput = document.createElement("input");
    dirInput.type = "text";
    dirInput.placeholder = "/var/backups (kubespray default)";
    dirInput.value = f.backupDir;
    dirInput.addEventListener("input", () => { f.backupDir = dirInput.value; updateOpsCommand(); });
    body.appendChild(opsField("Backup directory on each etcd node (optional)", dirInput));

    const note = document.createElement("div");
    note.className = "ops-note";
    note.textContent = "Installs a systemd timer (etcd-snapshot-backup.timer) on every etcd node that snapshots etcd on this schedule and prunes old snapshots. Safe to re-run any time you change these values. Check status with \"systemctl status etcd-snapshot-backup.timer\" on a node, or run \"systemctl start etcd-snapshot-backup.service\" to trigger one immediately.";
    body.appendChild(note);

    const syncNote = document.createElement("div");
    syncNote.className = "ops-note";
    syncNote.textContent = "If this webui is running via docker-compose, the backup-sync container periodically pulls these snapshot files off the etcd nodes and mirrors them into the RustFS bucket \"etcd-backups\" (see BACKUP_INVENTORY_NAME in .env).";
    body.appendChild(syncNote);
  }
}

function renderVarRow(entry) {
  const row = document.createElement("div");
  row.className = "var-row" + (entry.enabled ? "" : " disabled");
  row.dataset.key = entry.key;

  const toggleCell = document.createElement("div");
  toggleCell.className = "toggle-cell";
  const toggle = document.createElement("input");
  toggle.type = "checkbox";
  toggle.className = "switch";
  toggle.checked = entry.enabled;
  toggle.title = entry.enabled ? "Enabled (uncommented in file)" : "Disabled (commented out, default not applied)";
  toggle.addEventListener("change", () => onFieldChange(entry, { enabled: toggle.checked }));
  toggleCell.appendChild(toggle);
  row.appendChild(toggleCell);

  const keyCell = document.createElement("div");
  keyCell.className = "var-key-cell";
  keyCell.innerHTML = `<div class="var-key">${entry.key}</div>` +
    (entry.description ? `<div class="var-desc">${escapeHtml(entry.description)}</div>` : "");
  row.appendChild(keyCell);

  const valueCell = document.createElement("div");
  valueCell.className = "var-value-cell";
  valueCell.appendChild(renderValueInput(entry));
  row.appendChild(valueCell);

  return row;
}

function renderValueInput(entry) {
  if (entry.multiline || entry.type === "block") {
    const ta = document.createElement("textarea");
    ta.value = entry.value;
    ta.spellcheck = false;
    ta.addEventListener("input", () => onFieldChange(entry, { value: ta.value }));
    return ta;
  }
  if (entry.type === "bool") {
    const wrap = document.createElement("div");
    wrap.className = "bool-input";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.className = "switch";
    cb.checked = entry.value.trim().toLowerCase() === "true";
    const label = document.createElement("span");
    label.textContent = cb.checked ? "true" : "false";
    cb.addEventListener("change", () => {
      label.textContent = cb.checked ? "true" : "false";
      onFieldChange(entry, { value: cb.checked ? "true" : "false" });
    });
    wrap.appendChild(cb);
    wrap.appendChild(label);
    return wrap;
  }
  const input = document.createElement("input");
  input.type = entry.type === "int" || entry.type === "float" ? "number" : "text";
  if (entry.type === "float") input.step = "any";
  input.value = entry.value;
  input.spellcheck = false;
  input.addEventListener("input", () => onFieldChange(entry, { value: input.value }));
  return input;
}

function onFieldChange(entry, patch) {
  const cur = state.pending[entry.key] || { enabled: entry.enabled, value: entry.value };
  state.pending[entry.key] = { ...cur, ...patch };
  const row = document.querySelector(`.var-row[data-key="${cssEscape(entry.key)}"]`);
  if (row) row.classList.toggle("disabled", !state.pending[entry.key].enabled);
  updateDirtyIndicator();
}

function cssEscape(s) {
  return window.CSS && CSS.escape ? CSS.escape(s) : s;
}

function escapeHtml(s) {
  const d = document.createElement("div");
  d.textContent = s;
  return d.innerHTML.replace(/\n/g, "<br/>");
}

async function saveForm() {
  if (Object.keys(state.pending).length === 0) {
    showToast("Nothing to save.", "");
    return;
  }
  try {
    const data = await api(`/api/inventories/${state.inventory}/files/${state.currentPath}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ updates: state.pending }),
    });
    state.entries = data.entries;
    state.raw = data.raw;
    state.pending = {};
    renderFile();
    showToast("Saved.", "success");
  } catch (e) {
    showToast("Error: " + e.message, "error");
  }
}

function renderRaw(body) {
  const ta = document.createElement("textarea");
  ta.className = "raw-editor";
  ta.value = state.raw;
  ta.spellcheck = false;
  ta.id = "rawTextarea";
  body.appendChild(ta);
}

async function saveRaw() {
  const ta = el("#rawTextarea");
  try {
    const data = await api(`/api/inventories/${state.inventory}/files/${state.currentPath}/raw`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: ta.value }),
    });
    state.entries = data.entries;
    state.raw = data.raw;
    state.pending = {};
    renderFile();
    showToast("Saved.", "success");
  } catch (e) {
    showToast("Error: " + e.message, "error");
  }
}

async function onSearch() {
  const q = searchInput.value.trim();
  if (!q || !state.inventory) {
    searchResults.classList.add("hidden");
    return;
  }
  const data = await api(`/api/inventories/${state.inventory}/search?q=${encodeURIComponent(q)}`);
  searchResults.innerHTML = "";
  if (data.results.length === 0) {
    searchResults.innerHTML = `<div class="search-item">No matches.</div>`;
  } else {
    for (const r of data.results.slice(0, 40)) {
      const item = document.createElement("div");
      item.className = "search-item";
      item.innerHTML = `<span class="f">${r.file}</span><span class="k">${r.key}</span><div class="d">${escapeHtml(r.description || "")}</div>`;
      item.addEventListener("click", async () => {
        searchResults.classList.add("hidden");
        searchInput.value = "";
        await selectFile(r.file);
        setTimeout(() => {
          const row = document.querySelector(`.var-row[data-key="${cssEscape(r.key)}"]`);
          if (row) { row.scrollIntoView({ behavior: "smooth", block: "center" }); row.style.outline = "1px solid var(--accent)"; }
        }, 50);
      });
      searchResults.appendChild(item);
    }
  }
  searchResults.classList.remove("hidden");
}

init();
