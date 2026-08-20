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

// _stream_shell (backend/main.py) always appends "\n[exit code N]\n" as the
// last thing it streams - this is the only reliable signal of whether a
// streamed run actually succeeded. The stream ending without an HTTP error
// does NOT mean the underlying command succeeded (e.g. `create && register`
// where create() fails: the shell exits non-zero, but the whole response
// still streams and completes normally) - every run-completion handler must
// check this, not just assume success once the reader is done.
function parseExitCode(log) {
  const m = log.match(/\[exit code (-?\d+)\]\s*$/);
  return m ? parseInt(m[1], 10) : null;
}

// Polling redraws (renderX(freshData)) tear down and recreate the whole tab's
// DOM, including any log <pre> the user might have scrolled up in to read
// past output - recreating the element resets scrollTop to 0, which reads as
// the view "jumping back up" every ~4s while a run is in progress. Snapshot
// scrollTop by element id before the redraw and restore it after.
function preserveScroll(ids, redrawFn) {
  const positions = {};
  for (const id of ids) {
    const el = document.getElementById(id);
    if (el) positions[id] = el.scrollTop;
  }
  redrawFn();
  for (const id of ids) {
    const el = document.getElementById(id);
    if (el && positions[id] !== undefined) el.scrollTop = positions[id];
  }
}

async function api(path, opts) {
  const res = await fetch(path, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.detail || res.statusText);
  }
  return data;
}

const TOP_TABS = {
  files: "filesTabBtn",
  ops: "opsTabBtn",
  kubespray: "kubesprayTabBtn",
  offline: "offlineTabBtn",
  molecule: "moleculeTabBtn",
  installation: "installationTabBtn",
  cilium: "ciliumTabBtn",
};

async function init() {
  await loadInventories();
  invSelect.addEventListener("change", () => selectInventory(invSelect.value));
  el("#newInvBtn").addEventListener("click", createInventory);
  el("#deleteInvBtn").addEventListener("click", deleteInventory);
  el("#filesTabBtn").addEventListener("click", () => switchTab("files"));
  el("#opsTabBtn").addEventListener("click", () => switchTab("ops"));
  el("#kubesprayTabBtn").addEventListener("click", () => switchTab("kubespray"));
  el("#offlineTabBtn").addEventListener("click", () => switchTab("offline"));
  el("#moleculeTabBtn").addEventListener("click", () => switchTab("molecule"));
  el("#installationTabBtn").addEventListener("click", () => switchTab("installation"));
  el("#ciliumTabBtn").addEventListener("click", () => switchTab("cilium"));
  searchInput.addEventListener("input", debounce(onSearch, 250));
  document.addEventListener("click", (e) => {
    if (!searchResults.contains(e.target) && e.target !== searchInput) {
      searchResults.classList.add("hidden");
    }
  });
}

function setActiveTabButtons(tab) {
  for (const [key, id] of Object.entries(TOP_TABS)) {
    el(`#${id}`).classList.toggle("active", tab === key);
  }
}

async function switchTab(tab) {
  if (tab === state.topTab) {
    setActiveTabButtons(tab);
    return;
  }
  if (state.topTab === "files" && hasUnsavedChanges()) {
    if (!confirm("You have unsaved changes on the current view. Discard them?")) return;
  }
  state.topTab = tab;
  setActiveTabButtons(tab);
  sidebar.classList.toggle("hidden-tab", tab !== "files");
  if (tab === "ops") {
    await loadOps();
  } else if (tab === "kubespray") {
    await loadKubespray();
  } else if (tab === "offline") {
    await loadOffline();
  } else if (tab === "molecule") {
    await loadMolecule();
  } else if (tab === "installation") {
    await loadInstallation();
  } else if (tab === "cilium") {
    await loadCilium();
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

// ---------- Kubespray Version (git tag switcher) ----------

async function loadKubespray() {
  content.innerHTML = `<div class="empty-state"><p>Loading…</p></div>`;
  try {
    const data = await api("/api/kubespray/current");
    renderKubesprayIdle(data);
  } catch (e) {
    content.innerHTML = "";
    showToast("Error: " + e.message, "error");
  }
}

function renderKubesprayIdle(data) {
  const wrap = document.createElement("div");

  const header = document.createElement("div");
  header.className = "file-header";
  header.innerHTML = `<h2>Kubespray Version</h2><span class="path">origin tags</span>`;
  wrap.appendChild(header);

  const desc = document.createElement("div");
  desc.className = "file-desc";
  desc.textContent = "Fetches the 10 newest release tags (e.g. v2.31.0) from origin and lets you check one out into the kubespray checkout this webui runs against.";
  wrap.appendChild(desc);

  const current = document.createElement("div");
  current.className = "ops-note";
  current.innerHTML = `Current: <strong>${data.current}</strong>`;
  wrap.appendChild(current);

  if (data.dirty) {
    const dirtyNote = document.createElement("div");
    dirtyNote.className = "ops-note danger";
    dirtyNote.textContent = "The kubespray checkout has uncommitted changes. Switching versions is blocked until you commit or discard them (this protects any group_vars edits made from the Files tab).";
    wrap.appendChild(dirtyNote);
  }

  const toolbar = document.createElement("div");
  toolbar.className = "toolbar";
  toolbar.innerHTML = `<button id="fetchVersionsBtn" class="btn-primary">Fetch versions from origin</button>`;
  wrap.appendChild(toolbar);

  content.innerHTML = "";
  content.appendChild(wrap);

  el("#fetchVersionsBtn").addEventListener("click", fetchKubesprayVersions);
}

async function fetchKubesprayVersions() {
  content.innerHTML = `<div class="empty-state"><p>Fetching versions from origin…</p></div>`;
  try {
    const data = await api("/api/kubespray/versions");
    renderKubespray(data);
  } catch (e) {
    content.innerHTML = "";
    showToast("Error: " + e.message, "error");
  }
}

function renderKubespray(data) {
  const wrap = document.createElement("div");

  const header = document.createElement("div");
  header.className = "file-header";
  header.innerHTML = `<h2>Kubespray Version</h2><span class="path">origin tags</span>`;
  wrap.appendChild(header);

  const desc = document.createElement("div");
  desc.className = "file-desc";
  desc.textContent = "Fetches the 10 newest release tags (e.g. v2.31.0) from origin and lets you check one out into the kubespray checkout this webui runs against.";
  wrap.appendChild(desc);

  const current = document.createElement("div");
  current.className = "ops-note";
  current.innerHTML = `Current: <strong>${data.current}</strong>`;
  wrap.appendChild(current);

  if (data.dirty) {
    const dirtyNote = document.createElement("div");
    dirtyNote.className = "ops-note danger";
    dirtyNote.textContent = "The kubespray checkout has uncommitted changes. Switching versions is blocked until you commit or discard them (this protects any group_vars edits made from the Files tab).";
    wrap.appendChild(dirtyNote);
  }

  const toolbar = document.createElement("div");
  toolbar.className = "toolbar";
  toolbar.innerHTML = `<button id="refreshBranchesBtn" class="btn-secondary">Refresh versions</button>`;
  wrap.appendChild(toolbar);

  const list = document.createElement("div");
  list.className = "branch-list";
  for (const v of data.versions) {
    const row = document.createElement("div");
    row.className = "branch-row" + (v.name === data.current ? " active" : "");
    row.innerHTML = `
      <span class="branch-name">${v.name}</span>
      <span class="branch-date">${new Date(v.date).toLocaleString()}</span>
      <span class="branch-sha">${v.sha}</span>
    `;
    const btn = document.createElement("button");
    btn.className = "btn-primary";
    btn.textContent = v.name === data.current ? "Current" : "Checkout";
    btn.disabled = v.name === data.current || data.dirty;
    btn.addEventListener("click", () => checkoutKubesprayVersion(v.name));
    row.appendChild(btn);
    list.appendChild(row);
  }
  wrap.appendChild(list);

  content.innerHTML = "";
  content.appendChild(wrap);

  el("#refreshBranchesBtn").addEventListener("click", fetchKubesprayVersions);
}

async function checkoutKubesprayVersion(version) {
  if (!confirm(`Check out version "${version}" in the kubespray checkout? This changes the actual playbooks/roles used for every inventory.`)) return;
  try {
    await api("/api/kubespray/checkout", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ version }),
    });
    showToast(`Checked out "${version}".`, "success");
    await fetchKubesprayVersions();
  } catch (e) {
    showToast("Error: " + e.message, "error");
  }
}

// ---------- Offline / Air-gapped Install (command builder + real execution) ----------

const OFFLINE_STATUS_LABEL = {
  files_list: "files.list",
  images_list: "images.list",
  offline_files_dir: "offline-files/",
  offline_files_archive: "offline-files.tar.gz",
  container_images_archive: "container-images.tar.gz",
  pip_packages_dir: "pip-packages/",
  helm_charts_dir: "helm-charts/",
  os_packages_dir: "os-packages/",
};

const OFFLINE_STAGE_STATUS_KEY = {
  "generate-lists": ["files_list", "images_list"],
  "download-files": ["offline_files_dir", "offline_files_archive"],
  "container-images": ["container_images_archive"],
  "pip-packages": ["pip_packages_dir"],
  "os-packages": ["os_packages_dir"],
  "helm-charts": ["helm_charts_dir"],
};

// Stages with a real "Run" button. Backed by /api/inventories/{inv}/offline/run/{id}.
const OFFLINE_RUNNABLE = new Set(["generate-lists", "download-files", "container-images", "os-packages", "pip-packages"]);

if (!state.offlineForm) {
  const guessedHost = ["localhost", "127.0.0.1"].includes(location.hostname) ? "" : location.hostname;
  state.offlineForm = { registryMode: "local", registryAddress: "", ubuntuRelease: "24.04", hostAddress: guessedHost };
}
// Accumulated run output per stage id, kept across re-renders so a completed run's
// log isn't wiped out the moment the status refresh redraws the tab.
if (!state.offlineLogs) {
  state.offlineLogs = {};
}

async function loadOffline() {
  content.innerHTML = `<div class="empty-state"><p>Checking offline-install status…</p></div>`;
  try {
    const data = await api(`/api/inventories/${state.inventory}/offline/plan`);
    renderOffline(data);
  } catch (e) {
    content.innerHTML = "";
    showToast("Error: " + e.message, "error");
  }
}

function offlineStatusLine(data, stageId) {
  const keys = OFFLINE_STAGE_STATUS_KEY[stageId] || [];
  const parts = keys.map((k) => {
    const info = data.status[k];
    const label = OFFLINE_STATUS_LABEL[k];
    if (!info.exists) return `${label}: not generated yet`;
    if (info.line_count !== undefined) return `${label}: ${info.line_count} entries`;
    if (info.file_count !== undefined) return `${label}: ${info.file_count} files`;
    return `${label}: present`;
  });
  return parts.join(" · ");
}

async function runOfflineStage(stageId, body, logEl, btn) {
  const origText = btn.textContent;
  btn.disabled = true;
  btn.textContent = "Running…";
  logEl.style.display = "block";
  logEl.textContent = "";
  state.offlineLogs[stageId] = "";
  try {
    const res = await fetch(`/api/inventories/${state.inventory}/offline/run/${stageId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body || {}),
    });
    if (!res.ok) {
      // Errors caught before streaming starts (bad input, or another run of this
      // same stage already in progress - see OFFLINE_STAGE_LOCKS backend-side)
      // come back as plain JSON, not a stream - surface the real message instead
      // of dumping it raw into the log.
      const err = await res.json().catch(() => ({}));
      throw new Error(err.detail || res.statusText);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value, { stream: true });
      logEl.textContent += chunk;
      state.offlineLogs[stageId] += chunk;
      logEl.scrollTop = logEl.scrollHeight;
    }
    // Re-fetch status so the toast says exactly what got created (e.g. "files.list:
    // 24 entries"), then redraw the tab - this also fixes up Run-button
    // enabled/disabled state on OTHER stages that depended on this one, and
    // (since logEl's content was stashed in state.offlineLogs above) the redraw
    // restores this log instead of wiping it.
    const freshData = await api(`/api/inventories/${state.inventory}/offline/plan`);
    const line = offlineStatusLine(freshData, stageId);
    const code = parseExitCode(state.offlineLogs[stageId]);
    if (code === 0) {
      showToast(line ? `Done - ${line}` : "Done.", "success");
    } else {
      showToast(`${stageId} failed (exit code ${code}) - check the log.`, "error");
    }
    renderOffline(freshData);
  } catch (e) {
    showToast("Error: " + e.message, "error");
    btn.disabled = false;
    btn.textContent = origText;
  }
}

const OFFLINE_LOCAL_REGISTRY_PORT = 5000;
const OFFLINE_LOCAL_NGINX_PORT = 8080;
const OFFLINE_LOCAL_APT_PORT = 8081;
const OFFLINE_LOCAL_PIP_PORT = 8082;

// Mirrors offline.py's container_images_command() so the displayed command stays
// truthful while the user edits the registry fields (the real run always goes
// through the backend builder - this is display-only). "local" targets the
// always-on offline-registry compose service, already running - nothing to start.
function buildContainerImagesCommand(offlineDir) {
  const f = state.offlineForm;
  const dest = (f.registryMode === "remote" && f.registryAddress) ? f.registryAddress : `localhost:${OFFLINE_LOCAL_REGISTRY_PORT}`;
  return `cd ${offlineDir} && IMAGES_FROM_FILE=${offlineDir}/temp/images.list ` +
    `./manage-offline-container-images.sh create && DESTINATION_REGISTRY=${dest} ./manage-offline-container-images.sh register`;
}

// Mirrors offline.py's os_packages_command(). offlineDir is the container-internal
// path (used for mkdir, run inside this container); hostOfflineDir is the real
// host path (needed for the throwaway ubuntu container's `docker run -v`, since
// that's resolved by the HOST daemon via the mounted socket) - see offline.py.
function buildOsPackagesCommand(offlineDir, hostOfflineDir, packages) {
  const f = state.offlineForm;
  const outdir = `${offlineDir}/os-packages`;
  const hostOutdir = `${hostOfflineDir}/os-packages`;
  return `mkdir -p ${outdir} && docker run --rm -v ${hostOutdir}:/var/cache/apt/archives ` +
    `ubuntu:${f.ubuntuRelease} bash -c "apt-get update -q && apt-get install --download-only -y ${packages.join(" ")}" && ` +
    `cd ${outdir} && dpkg-scanpackages . /dev/null 2>/dev/null | gzip -9c > Packages.gz`;
}

// Silent background check while a stage is running (server-side, per
// OFFLINE_STAGE_LOCKS/OFFLINE_STAGE_LOGS in main.py - both outlive this page load,
// e.g. after a refresh, or a different tab looking). Only touches the DOM (a full
// renderOffline redraw) when something actually changed (a stage started/finished,
// or its log grew) - not on every tick - so it doesn't blow away whatever the user
// is doing on unrelated cards (typing in a field, mid-scroll) the way redrawing on
// a fixed timer regardless of change would.
async function pollOfflineRunning(previousSnapshot) {
  if (state.topTab !== "offline") return;
  try {
    const freshData = await api(`/api/inventories/${state.inventory}/offline/plan`);
    const snapshot = { running: freshData.running, logs: freshData.logs };
    const changed = JSON.stringify(snapshot) !== JSON.stringify(previousSnapshot);
    if (changed) {
      renderOffline(freshData);
    } else if (Object.values(freshData.running).some(Boolean)) {
      setTimeout(() => pollOfflineRunning(snapshot), 4000);
    }
  } catch (e) {
    // Transient - the next manual tab switch/reload will surface real errors.
  }
}

// "Point kubespray at these repos": writes registry_host/files_repo/ubuntu_repo/
// debian_repo into this inventory's offline.yml (reusing the same group_vars
// update mechanism the Files tab uses), pointing at the address the real target
// k8s nodes - separate machines - will reach this host at. Deliberately not
// auto-filled with "localhost": that's only correct for the container-images push
// step, which runs locally via the Docker socket.
function renderOfflineConfigureCard() {
  const card = document.createElement("div");
  card.className = "host-card";

  const header = document.createElement("div");
  header.className = "file-header";
  header.innerHTML = `<h2 style="font-size:15px">Point kubespray at these repos</h2>`;
  card.appendChild(header);

  const note = document.createElement("div");
  note.className = "ops-note";
  note.textContent = "Writes registry_host/files_repo/ubuntu_repo/debian_repo into this inventory's offline.yml. Use the address your CLUSTER NODES will reach this host at - not localhost, which only makes sense for the push step above (that runs locally via the Docker socket).";
  note.style.marginBottom = "10px";
  card.appendChild(note);

  const form = document.createElement("div");
  form.className = "ops-fields";

  const hostInput = document.createElement("input");
  hostInput.type = "text";
  hostInput.placeholder = "e.g. 192.168.1.50 or repo-host.example.com";
  hostInput.value = state.offlineForm.hostAddress;

  const preview = document.createElement("textarea");
  preview.className = "raw-editor ops-cmd-output";
  preview.readOnly = true;
  preview.spellcheck = false;
  preview.style.marginTop = "10px";
  preview.style.minHeight = "110px";

  function refreshPreview() {
    const h = state.offlineForm.hostAddress;
    preview.value = h
      ? `registry_host: "${h}:${OFFLINE_LOCAL_REGISTRY_PORT}"\n` +
        `files_repo: "http://${h}:${OFFLINE_LOCAL_NGINX_PORT}"\n` +
        `ubuntu_repo: "http://${h}:${OFFLINE_LOCAL_APT_PORT}"\n` +
        `debian_repo: "http://${h}:${OFFLINE_LOCAL_APT_PORT}"`
      : "Enter a host address above to preview the values.";
  }
  hostInput.addEventListener("input", () => {
    state.offlineForm.hostAddress = hostInput.value;
    refreshPreview();
  });
  refreshPreview();

  form.appendChild(opsField("This host's address, as reached from your cluster nodes", hostInput));
  card.appendChild(form);
  card.appendChild(preview);

  const writeBtn = document.createElement("button");
  writeBtn.className = "btn-primary";
  writeBtn.style.marginTop = "10px";
  writeBtn.textContent = "Write to offline.yml";
  writeBtn.addEventListener("click", async () => {
    const host = state.offlineForm.hostAddress;
    if (!host) {
      showToast("Enter a host address first.", "error");
      return;
    }
    if (!confirm(`Write registry_host/files_repo/ubuntu_repo/debian_repo into inventory/${state.inventory}/group_vars/all/offline.yml, pointing at "${host}"?`)) return;
    try {
      await api(`/api/inventories/${state.inventory}/offline/configure`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ host_address: host }),
      });
      showToast("offline.yml updated.", "success");
    } catch (e) {
      showToast("Error: " + e.message, "error");
    }
  });
  card.appendChild(writeBtn);

  return card;
}

function renderOffline(data) {
  const wrap = document.createElement("div");

  const header = document.createElement("div");
  header.className = "file-header";
  header.innerHTML = `<h2>Offline / Air-gapped Install</h2><span class="path">${state.inventory || ""}</span>`;
  wrap.appendChild(header);

  const desc = document.createElement("div");
  desc.className = "file-desc";
  desc.textContent = "Prepares every artifact kubespray needs for an air-gapped install of the currently checked-out version. Generate lists, download files, and container images/OS packages can be run for real from here.";
  wrap.appendChild(desc);

  const dangerBanner = document.createElement("div");
  dangerBanner.className = "ops-note danger";
  dangerBanner.textContent = "Running these here uses this host's real Docker daemon, via a socket mounted into the webui container - the webui can now start/stop/build anything on this machine. The webui itself has no login, so anyone who can reach it can do the same.";
  wrap.appendChild(dangerBanner);

  const summary = document.createElement("div");
  summary.className = "ops-note";
  summary.innerHTML = `Kubespray version: <strong>${data.current_version}</strong> &nbsp;·&nbsp; ` +
    `container_manager: <strong>${data.config.container_manager}</strong> &nbsp;·&nbsp; ` +
    `kube_network_plugin: <strong>${data.config.kube_network_plugin}</strong> &nbsp;·&nbsp; ` +
    `helm_enabled: <strong>${data.config.helm_enabled}</strong>`;
  wrap.appendChild(summary);

  for (const stage of data.stages) {
    const card = document.createElement("div");
    card.className = "host-card";

    const stageHeader = document.createElement("div");
    stageHeader.className = "file-header";
    const statusLine = offlineStatusLine(data, stage.id);
    stageHeader.innerHTML = `<h2 style="font-size:15px">${stage.title}</h2>` +
      `<span class="path">${stage.relevant ? (statusLine || "") : "not needed for this inventory"}</span>`;
    card.appendChild(stageHeader);

    const note = document.createElement("div");
    note.className = "ops-note" + (stage.id === "container-images" ? " danger" : "");
    note.textContent = stage.note;
    note.style.marginBottom = "10px";
    card.appendChild(note);

    if (stage.relevant) {
      const outputRow = document.createElement("div");
      outputRow.className = "ops-cmd-row";
      const output = document.createElement("textarea");
      output.className = "raw-editor ops-cmd-output";
      output.readOnly = true;
      output.spellcheck = false;
      output.value = stage.command;
      const copyBtn = document.createElement("button");
      copyBtn.className = "btn-primary";
      copyBtn.textContent = "Copy";
      copyBtn.addEventListener("click", async () => {
        await navigator.clipboard.writeText(output.value);
        showToast("Command copied.", "success");
      });
      outputRow.appendChild(output);
      outputRow.appendChild(copyBtn);
      card.appendChild(outputRow);

      if (stage.id === "container-images") {
        const form = document.createElement("div");
        form.className = "ops-fields";
        form.style.marginTop = "12px";
        form.style.marginBottom = "0";

        const localRadio = document.createElement("input");
        localRadio.type = "radio";
        localRadio.name = "offlineRegistryMode";
        localRadio.checked = state.offlineForm.registryMode === "local";
        const remoteRadio = document.createElement("input");
        remoteRadio.type = "radio";
        remoteRadio.name = "offlineRegistryMode";
        remoteRadio.checked = state.offlineForm.registryMode === "remote";
        const addressInput = document.createElement("input");
        addressInput.type = "text";
        addressInput.placeholder = "registry.example.com:5000";
        addressInput.value = state.offlineForm.registryAddress;
        addressInput.disabled = state.offlineForm.registryMode !== "remote";

        const refresh = () => { output.value = buildContainerImagesCommand(data.offline_dir); };
        localRadio.addEventListener("change", () => { state.offlineForm.registryMode = "local"; addressInput.disabled = true; refresh(); });
        remoteRadio.addEventListener("change", () => { state.offlineForm.registryMode = "remote"; addressInput.disabled = false; refresh(); });
        addressInput.addEventListener("input", () => { state.offlineForm.registryAddress = addressInput.value; refresh(); });

        form.appendChild(opsField("Start a local registry (localhost:5000)", localRadio));
        form.appendChild(opsField("Use an existing registry", remoteRadio));
        form.appendChild(opsField("Registry address", addressInput));
        card.appendChild(form);
      }

      if (stage.id === "os-packages") {
        const form = document.createElement("div");
        form.className = "ops-fields";
        form.style.marginTop = "12px";
        form.style.marginBottom = "0";

        const releaseInput = document.createElement("input");
        releaseInput.type = "text";
        releaseInput.value = state.offlineForm.ubuntuRelease;
        releaseInput.addEventListener("input", () => {
          state.offlineForm.ubuntuRelease = releaseInput.value;
          output.value = buildOsPackagesCommand(data.offline_dir, data.host_offline_dir, stage.packages);
        });
        form.appendChild(opsField("Ubuntu release (target nodes)", releaseInput));
        card.appendChild(form);
      }

      if (OFFLINE_RUNNABLE.has(stage.id)) {
        const runRow = document.createElement("div");
        runRow.style.marginTop = "10px";
        const runBtn = document.createElement("button");
        runBtn.className = "btn-primary";
        runBtn.textContent = "▶ Run";

        if (stage.id === "download-files" && !data.status.files_list.exists) {
          runBtn.disabled = true;
          runBtn.title = "Run \"Generate file & image lists\" first.";
        }
        if (stage.id === "container-images" && !data.status.images_list.exists) {
          runBtn.disabled = true;
          runBtn.title = "Run \"Generate file & image lists\" first.";
        }
        // Server-side run state (OFFLINE_STAGE_LOCKS in main.py), not just this
        // tab's in-memory state - so a run started before a page refresh (or from
        // another browser tab) still shows as running instead of a misleading
        // fresh "▶ Run" button. renderOffline() re-polls below while this is true.
        if (data.running[stage.id]) {
          runBtn.disabled = true;
          runBtn.textContent = "Running… (started elsewhere)";
          runBtn.title = "A run of this stage is already in progress, possibly from before this page load - this will update on its own once it finishes.";
        }

        const logEl = document.createElement("pre");
        logEl.className = "raw-editor ops-cmd-output offline-log";
        // Prefer the server's copy (OFFLINE_STAGE_LOGS in main.py) over this tab's
        // own in-memory state - the server's persists across a refresh and is
        // visible from any tab, this tab's own state is neither.
        const priorLog = (data.logs && data.logs[stage.id]) || state.offlineLogs[stage.id];
        state.offlineLogs[stage.id] = priorLog || "";
        logEl.textContent = priorLog || "";
        logEl.style.display = priorLog ? "block" : "none";
        logEl.style.marginTop = "10px";

        runBtn.addEventListener("click", () => {
          let body = {};
          if (stage.id === "container-images") {
            body = { registry_mode: state.offlineForm.registryMode, registry_address: state.offlineForm.registryAddress };
          } else if (stage.id === "os-packages") {
            body = { ubuntu_release: state.offlineForm.ubuntuRelease };
          }
          runOfflineStage(stage.id, body, logEl, runBtn);
        });

        runRow.appendChild(runBtn);
        card.appendChild(runRow);
        card.appendChild(logEl);
      }

      if (stage.id === "helm-charts") {
        const form = document.createElement("div");
        form.className = "ops-fields";
        form.style.marginTop = "12px";
        form.style.marginBottom = "0";

        const repoName = document.createElement("input");
        repoName.type = "text";
        repoName.placeholder = "e.g. ingress-nginx";
        const repoUrl = document.createElement("input");
        repoUrl.type = "text";
        repoUrl.placeholder = "e.g. https://kubernetes.github.io/ingress-nginx";
        const chartName = document.createElement("input");
        chartName.type = "text";
        chartName.placeholder = "e.g. ingress-nginx/ingress-nginx";
        const chartVersion = document.createElement("input");
        chartVersion.type = "text";
        chartVersion.placeholder = "e.g. 4.13.3";

        form.appendChild(opsField("Repo name", repoName));
        form.appendChild(opsField("Repo URL", repoUrl));
        form.appendChild(opsField("Chart name", chartName));
        form.appendChild(opsField("Chart version", chartVersion));

        const addBtn = document.createElement("button");
        addBtn.className = "btn-secondary";
        addBtn.textContent = "Add another chart to the command above";
        addBtn.addEventListener("click", () => {
          if (!repoName.value || !repoUrl.value || !chartName.value || !chartVersion.value) {
            showToast("Fill in all four fields first.", "error");
            return;
          }
          output.value += `\n\nhelm repo add ${repoName.value} ${repoUrl.value} && helm repo update && ` +
            `helm pull ${chartName.value} --version ${chartVersion.value} --destination ${output.value.match(/--destination (\S+)/)?.[1] || "./helm-charts"}`;
        });
        form.appendChild(addBtn);
        card.appendChild(form);
      }
    }

    wrap.appendChild(card);
  }

  wrap.appendChild(renderOfflineConfigureCard());

  content.innerHTML = "";
  content.appendChild(wrap);

  if (Object.values(data.running).some(Boolean)) {
    setTimeout(() => pollOfflineRunning({ running: data.running, logs: data.logs }), 4000);
  }
}

// ---------- Ansible Molecule (real kubespray role tests) ----------
// Structurally mirrors the Offline Install tab above (same server-side
// lock/log/streaming mechanism in main.py, same "survive a refresh, only
// redraw on real change" polling) - not inventory-scoped, since Molecule
// tests a kubespray role in isolation, independent of any cluster config.
// Separate from the Installation tab (real cluster install) - kept as its
// own nav item per the user's explicit split.

if (!state.moleculeLogs) {
  state.moleculeLogs = {};
}

async function loadMolecule() {
  content.innerHTML = `<div class="empty-state"><p>Checking status…</p></div>`;
  try {
    const data = await api("/api/molecule/plan");
    renderMolecule(data);
  } catch (e) {
    content.innerHTML = "";
    showToast("Error: " + e.message, "error");
  }
}

async function pollMoleculeRunning(previousSnapshot) {
  if (state.topTab !== "molecule") return;
  try {
    const freshData = await api("/api/molecule/plan");
    const snapshot = { running: freshData.running, logs: freshData.logs };
    const changed = JSON.stringify(snapshot) !== JSON.stringify(previousSnapshot);
    if (changed) {
      renderMolecule(freshData);
    } else if (Object.values(freshData.running).some(Boolean)) {
      setTimeout(() => pollMoleculeRunning(snapshot), 4000);
    }
  } catch (e) {
    // Transient - the next manual tab switch/reload will surface real errors.
  }
}

async function runMoleculeRole(role, logEl, btn) {
  const origText = btn.textContent;
  btn.disabled = true;
  btn.textContent = "Running…";
  logEl.style.display = "block";
  logEl.textContent = "";
  state.moleculeLogs[role] = "";
  try {
    const res = await fetch(`/api/molecule/run/${role}`, { method: "POST" });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.detail || res.statusText);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value, { stream: true });
      logEl.textContent += chunk;
      state.moleculeLogs[role] += chunk;
      logEl.scrollTop = logEl.scrollHeight;
    }
    const freshData = await api("/api/molecule/plan");
    const code = parseExitCode(state.moleculeLogs[role]);
    if (code === 0) {
      showToast(`${role}: passed.`, "success");
    } else {
      showToast(`${role}: failed (exit code ${code}) - check the log.`, "error");
    }
    renderMolecule(freshData);
  } catch (e) {
    showToast("Error: " + e.message, "error");
    btn.disabled = false;
    btn.textContent = origText;
  }
}

function renderMolecule(data) {
  const wrap = document.createElement("div");

  const header = document.createElement("div");
  header.className = "file-header";
  header.innerHTML = `<h2>Ansible Molecule</h2><span class="path">kubespray role tests</span>`;
  wrap.appendChild(header);

  const desc = document.createElement("div");
  desc.className = "file-desc";
  desc.textContent = "Runs real Molecule tests (create → converge → idempotence → destroy) against kubespray roles, using a plain Docker container - not kubespray's own KubeVirt-based CI scenarios, which need real cloud infrastructure this box doesn't have.";
  wrap.appendChild(desc);

  const dangerBanner = document.createElement("div");
  dangerBanner.className = "ops-note danger";
  dangerBanner.textContent = "Runs via this host's real Docker daemon (the same socket mount the Offline Install tab uses) - creates and destroys real test containers on this machine.";
  wrap.appendChild(dangerBanner);

  for (const role of data.roles) {
    const card = document.createElement("div");
    card.className = "host-card";

    const cardHeader = document.createElement("div");
    cardHeader.className = "file-header";
    cardHeader.innerHTML = `<h2 style="font-size:15px">${role.title}</h2>` +
      `<span class="path">${data.running[role.id] ? "running…" : ""}</span>`;
    card.appendChild(cardHeader);

    const note = document.createElement("div");
    note.className = "ops-note";
    note.textContent = role.description;
    note.style.marginBottom = "10px";
    card.appendChild(note);

    const runRow = document.createElement("div");
    runRow.style.marginTop = "10px";
    const runBtn = document.createElement("button");
    runBtn.className = "btn-primary";
    runBtn.textContent = "▶ Run";

    if (data.running[role.id]) {
      runBtn.disabled = true;
      runBtn.textContent = "Running… (started elsewhere)";
      runBtn.title = "A run of this role is already in progress, possibly from before this page load - this will update on its own once it finishes.";
    }

    const logEl = document.createElement("pre");
    logEl.className = "raw-editor ops-cmd-output offline-log";
    const priorLog = (data.logs && data.logs[role.id]) || state.moleculeLogs[role.id];
    state.moleculeLogs[role.id] = priorLog || "";
    logEl.textContent = priorLog || "";
    logEl.style.display = priorLog ? "block" : "none";
    logEl.style.marginTop = "10px";

    runBtn.addEventListener("click", () => runMoleculeRole(role.id, logEl, runBtn));

    runRow.appendChild(runBtn);
    card.appendChild(runRow);
    card.appendChild(logEl);

    wrap.appendChild(card);
  }

  content.innerHTML = "";
  content.appendChild(wrap);

  if (Object.values(data.running).some(Boolean)) {
    setTimeout(() => pollMoleculeRunning({ running: data.running, logs: data.logs }), 4000);
  }
}

// ---------- Installation (real cluster install: ansible-playbook cluster.yml) ----------
// Separate from Ansible Molecule (role-level tests, not inventory-scoped) per
// the user's explicit split - this one installs Kubernetes for real onto
// whatever hosts the selected inventory points at. Inventory-scoped, unlike
// Molecule; structurally mirrors the Offline Install tab's run/poll/log
// pattern otherwise.

if (!state.installationLog) {
  state.installationLog = "";
}
if (!state.connectivityLog) {
  state.connectivityLog = "";
}
if (!state.verifyLog) {
  state.verifyLog = "";
}
if (!state.installationForm) {
  // authMethod "publickey" relies on the webui container's own mounted SSH_DIR
  // (same key(s) the backup-sync service already uses) reaching these hosts -
  // "password" sends -e ansible_ssh_pass/ansible_become_pass instead (see
  // main.py's run_installation - -k/-K would prompt interactively, which this
  // streamed-subprocess model has no way to answer).
  state.installationForm = { sshUser: "", authMethod: "publickey", sshPassword: "" };
}

// Mirrors run_installation()'s command construction so the preview stays
// truthful while the user edits fields - the real run always goes through
// the backend builder with the real password; this just masks it for display.
function buildInstallationCommand(baseCommand) {
  const f = state.installationForm;
  let cmd = baseCommand;
  if (f.sshUser) cmd += ` -u ${f.sshUser}`;
  if (f.authMethod === "password") {
    cmd += ` -e ansible_ssh_pass=*** -e ansible_become_pass=***`;
  }
  return cmd;
}

async function loadInstallation() {
  content.innerHTML = `<div class="empty-state"><p>Checking installation status…</p></div>`;
  try {
    const data = await api(`/api/inventories/${state.inventory}/installation/plan`);
    renderInstallation(data);
  } catch (e) {
    content.innerHTML = "";
    showToast("Error: " + e.message, "error");
  }
}

async function pollInstallationRunning(previousSnapshot) {
  if (state.topTab !== "installation") return;
  try {
    const freshData = await api(`/api/inventories/${state.inventory}/installation/plan`);
    const snapshot = {
      running: freshData.running, log: freshData.log,
      connectivity_running: freshData.connectivity_running, connectivity_log: freshData.connectivity_log,
      verify_running: freshData.verify_running, verify_log: freshData.verify_log,
    };
    const changed = JSON.stringify(snapshot) !== JSON.stringify(previousSnapshot);
    if (changed) {
      preserveScroll(
        ["installationConnectivityLog", "installationInstallLog", "installationVerifyLog"],
        () => renderInstallation(freshData)
      );
    } else if (freshData.running || freshData.connectivity_running || freshData.verify_running) {
      setTimeout(() => pollInstallationRunning(snapshot), 4000);
    }
  } catch (e) {
    // Transient - the next manual tab switch/reload will surface real errors.
  }
}

async function runConnectivityCheck(logEl, btn) {
  const f = state.installationForm;
  if (f.authMethod === "password" && !f.sshPassword) {
    showToast("Enter a password, or switch to Public key auth.", "error");
    return;
  }
  const origText = btn.textContent;
  btn.disabled = true;
  btn.textContent = "Checking…";
  logEl.style.display = "block";
  logEl.textContent = "";
  state.connectivityLog = "";
  try {
    const res = await fetch(`/api/inventories/${state.inventory}/installation/check-connectivity`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ssh_user: f.sshUser || null,
        auth_method: f.authMethod,
        ssh_password: f.authMethod === "password" ? f.sshPassword : null,
      }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.detail || res.statusText);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value, { stream: true });
      logEl.textContent += chunk;
      state.connectivityLog += chunk;
      logEl.scrollTop = logEl.scrollHeight;
    }
    const connCode = parseExitCode(state.connectivityLog);
    if (connCode === 0) {
      showToast("Connectivity check passed - all hosts reachable.", "success");
    } else {
      showToast(`Connectivity check found problems (exit code ${connCode}) - see the log.`, "error");
    }
  } catch (e) {
    showToast("Error: " + e.message, "error");
  } finally {
    btn.disabled = false;
    btn.textContent = origText;
  }
}

async function runVerifyCluster(logEl, btn) {
  const f = state.installationForm;
  if (f.authMethod === "password" && !f.sshPassword) {
    showToast("Enter a password, or switch to Public key auth.", "error");
    return;
  }
  const origText = btn.textContent;
  btn.disabled = true;
  btn.textContent = "Verifying…";
  logEl.style.display = "block";
  logEl.textContent = "";
  state.verifyLog = "";
  try {
    const res = await fetch(`/api/inventories/${state.inventory}/installation/verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ssh_user: f.sshUser || null,
        auth_method: f.authMethod,
        ssh_password: f.authMethod === "password" ? f.sshPassword : null,
      }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.detail || res.statusText);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value, { stream: true });
      logEl.textContent += chunk;
      state.verifyLog += chunk;
      logEl.scrollTop = logEl.scrollHeight;
    }
    const passed = state.verifyLog.includes("CLUSTER VERIFICATION PASSED");
    showToast(passed ? "Cluster verification passed." : "Cluster verification found problems - see the log.", passed ? "success" : "error");
  } catch (e) {
    showToast("Error: " + e.message, "error");
  } finally {
    btn.disabled = false;
    btn.textContent = origText;
  }
}

async function runInstallation(logEl, btn) {
  const f = state.installationForm;
  if (f.authMethod === "password" && !f.sshPassword) {
    showToast("Enter a password, or switch to Public key auth.", "error");
    return;
  }
  if (!confirm(
    `Really run a real cluster install (ansible-playbook cluster.yml) against inventory "${state.inventory}"? ` +
    `This installs Kubernetes components on every host in that inventory - there's no undo short of running reset.yml.`
  )) return;
  const origText = btn.textContent;
  btn.disabled = true;
  btn.textContent = "Running…";
  logEl.style.display = "block";
  logEl.textContent = "";
  state.installationLog = "";
  try {
    const res = await fetch(`/api/inventories/${state.inventory}/installation/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        confirm: true,
        ssh_user: f.sshUser || null,
        auth_method: f.authMethod,
        ssh_password: f.authMethod === "password" ? f.sshPassword : null,
      }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.detail || res.statusText);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value, { stream: true });
      logEl.textContent += chunk;
      state.installationLog += chunk;
      logEl.scrollTop = logEl.scrollHeight;
    }
    const freshData = await api(`/api/inventories/${state.inventory}/installation/plan`);
    const installCode = parseExitCode(state.installationLog);
    if (installCode === 0) {
      showToast("Installation finished successfully - check the log for the play recap.", "success");
    } else {
      showToast(`Installation failed (exit code ${installCode}) - check the log.`, "error");
    }
    renderInstallation(freshData);
  } catch (e) {
    showToast("Error: " + e.message, "error");
    btn.disabled = false;
    btn.textContent = origText;
  }
}

function renderInstallation(data) {
  const wrap = document.createElement("div");

  const header = document.createElement("div");
  header.className = "file-header";
  header.innerHTML = `<h2>Installation</h2><span class="path">inventory/${state.inventory}</span>`;
  wrap.appendChild(header);

  const desc = document.createElement("div");
  desc.className = "file-desc";
  desc.textContent = "Runs the real kubespray cluster install (ansible-playbook cluster.yml) against this inventory's hosts.";
  wrap.appendChild(desc);

  const dangerBanner = document.createElement("div");
  dangerBanner.className = "ops-note danger";
  dangerBanner.textContent = "This installs real Kubernetes components (containerd, kubelet, etcd, control plane, etc.) on every host in this inventory. There is no undo short of running reset.yml against the same hosts.";
  wrap.appendChild(dangerBanner);

  const form = document.createElement("div");
  form.className = "ops-fields";

  const userInput = document.createElement("input");
  userInput.type = "text";
  userInput.placeholder = "(defaults to inventory's ansible_user)";
  userInput.value = state.installationForm.sshUser;

  const keyRadio = document.createElement("input");
  keyRadio.type = "radio";
  keyRadio.name = "installationAuthMethod";
  keyRadio.checked = state.installationForm.authMethod === "publickey";
  const passRadio = document.createElement("input");
  passRadio.type = "radio";
  passRadio.name = "installationAuthMethod";
  passRadio.checked = state.installationForm.authMethod === "password";

  const passwordInput = document.createElement("input");
  passwordInput.type = "password";
  passwordInput.placeholder = "SSH + sudo password";
  passwordInput.value = state.installationForm.sshPassword;
  passwordInput.disabled = state.installationForm.authMethod !== "password";

  const cmdBox = document.createElement("pre");
  cmdBox.className = "raw-editor ops-cmd-output";
  cmdBox.textContent = buildInstallationCommand(data.command);
  cmdBox.style.marginBottom = "10px";

  const refreshCmd = () => { cmdBox.textContent = buildInstallationCommand(data.command); };
  userInput.addEventListener("input", () => { state.installationForm.sshUser = userInput.value; refreshCmd(); });
  keyRadio.addEventListener("change", () => {
    state.installationForm.authMethod = "publickey";
    passwordInput.disabled = true;
    refreshCmd();
  });
  passRadio.addEventListener("change", () => {
    state.installationForm.authMethod = "password";
    passwordInput.disabled = false;
    refreshCmd();
  });
  passwordInput.addEventListener("input", () => { state.installationForm.sshPassword = passwordInput.value; refreshCmd(); });

  form.appendChild(opsField("SSH user (-u)", userInput));
  form.appendChild(opsField("Public key (uses this host's mounted SSH keys)", keyRadio));
  form.appendChild(opsField("Password", passRadio));
  form.appendChild(opsField("Password value", passwordInput));
  wrap.appendChild(form);

  const checkRow = document.createElement("div");
  const checkBtn = document.createElement("button");
  checkBtn.className = "btn-secondary";
  checkBtn.textContent = "🔌 Check connectivity";
  checkBtn.title = "Read-only - runs ansible -m ping against every host in this inventory using the fields above. Doesn't touch cluster.yml or any host state.";

  if (data.connectivity_running) {
    checkBtn.disabled = true;
    checkBtn.textContent = "Checking… (started elsewhere)";
  }

  const checkLogEl = document.createElement("pre");
  checkLogEl.id = "installationConnectivityLog";
  checkLogEl.className = "raw-editor ops-cmd-output offline-log";
  const priorCheckLog = data.connectivity_log || state.connectivityLog;
  state.connectivityLog = priorCheckLog || "";
  checkLogEl.textContent = priorCheckLog || "";
  checkLogEl.style.display = priorCheckLog ? "block" : "none";
  checkLogEl.style.marginTop = "10px";
  checkLogEl.style.marginBottom = "10px";

  checkBtn.addEventListener("click", () => runConnectivityCheck(checkLogEl, checkBtn));

  checkRow.appendChild(checkBtn);
  wrap.appendChild(checkRow);
  wrap.appendChild(checkLogEl);

  wrap.appendChild(cmdBox);

  const runRow = document.createElement("div");
  const runBtn = document.createElement("button");
  runBtn.className = "btn-danger";
  runBtn.textContent = "▶ Run cluster install";

  if (data.running) {
    runBtn.disabled = true;
    runBtn.textContent = "Running… (started elsewhere)";
    runBtn.title = "An install run for this inventory is already in progress, possibly from before this page load - this will update on its own once it finishes.";
  }

  const logEl = document.createElement("pre");
  logEl.id = "installationInstallLog";
  logEl.className = "raw-editor ops-cmd-output offline-log";
  const priorLog = data.log || state.installationLog;
  state.installationLog = priorLog || "";
  logEl.textContent = priorLog || "";
  logEl.style.display = priorLog ? "block" : "none";
  logEl.style.marginTop = "10px";

  runBtn.addEventListener("click", () => runInstallation(logEl, runBtn));

  runRow.appendChild(runBtn);
  wrap.appendChild(runRow);
  wrap.appendChild(logEl);

  const verifyDesc = document.createElement("div");
  verifyDesc.className = "file-desc";
  verifyDesc.textContent = "After install: checks the real cluster (not just that cluster.yml exited 0) - every node Ready, every pod Running/Succeeded, via kubectl on the first control-plane host.";
  verifyDesc.style.marginTop = "16px";
  wrap.appendChild(verifyDesc);

  const verifyRow = document.createElement("div");
  const verifyBtn = document.createElement("button");
  verifyBtn.className = "btn-secondary";
  verifyBtn.textContent = "✅ Verify cluster";
  verifyBtn.title = "Read-only - runs kubectl get nodes/pods over SSH using the fields above. Doesn't change anything.";

  if (data.verify_running) {
    verifyBtn.disabled = true;
    verifyBtn.textContent = "Verifying… (started elsewhere)";
  }

  const verifyLogEl = document.createElement("pre");
  verifyLogEl.id = "installationVerifyLog";
  verifyLogEl.className = "raw-editor ops-cmd-output offline-log";
  const priorVerifyLog = data.verify_log || state.verifyLog;
  state.verifyLog = priorVerifyLog || "";
  verifyLogEl.textContent = priorVerifyLog || "";
  verifyLogEl.style.display = priorVerifyLog ? "block" : "none";
  verifyLogEl.style.marginTop = "10px";

  verifyBtn.addEventListener("click", () => runVerifyCluster(verifyLogEl, verifyBtn));

  verifyRow.appendChild(verifyBtn);
  wrap.appendChild(verifyRow);
  wrap.appendChild(verifyLogEl);

  content.innerHTML = "";
  content.appendChild(wrap);

  if (data.running || data.connectivity_running || data.verify_running) {
    setTimeout(() => pollInstallationRunning({
      running: data.running, log: data.log,
      connectivity_running: data.connectivity_running, connectivity_log: data.connectivity_log,
      verify_running: data.verify_running, verify_log: data.verify_log,
    }), 4000);
  }
}

// ---------- Cilium (install/upgrade via Helm, connectivity test, per-node status) ----------
// Separate from Installation - this manages Cilium's own lifecycle via Helm,
// independent of whichever CNI (if any) cluster.yml itself set up. Real
// execution, streamed, same pattern as Installation - but bypasses
// ansible-playbook for install/connectivity-test specifically (see
// backend/cilium.py's module docstring for why: ansible's shell/command
// modules buffer a whole task's output until it finishes, which would make
// a multi-minute helm upgrade or connectivity test look hung with no
// progress). Both stream via the same backend _stream_shell() everything
// else already uses, just fed by a raw SSH command instead of ansible.

if (!state.ciliumInstallLog) state.ciliumInstallLog = "";
if (!state.ciliumUninstallLog) state.ciliumUninstallLog = "";
if (!state.ciliumConnectivityLog) state.ciliumConnectivityLog = "";
if (!state.ciliumForm) {
  state.ciliumForm = {
    sshUser: "", authMethod: "publickey", sshPassword: "",
    version: "",
    routingMode: "tunnel", tunnelProtocol: "vxlan",
    kubeProxyReplacement: false,
    k8sServiceHost: "", k8sServicePort: "6443",
    hubbleEnabled: true, hubbleRelayEnabled: true, hubbleUiEnabled: false,
    encryptionEnabled: false, encryptionType: "wireguard",
    ipamMode: "cluster-pool",
    clusterName: "default", clusterId: "0",
    valuesYaml: "",
  };
}

// Generates a values.yaml from the curated fields - a starting point the
// user can hand-edit afterward in the actual (separate) values.yaml
// textarea, which is what really gets sent on install, not these fields
// directly. Only overwrites the textarea when the user clicks "Generate",
// never automatically, so manual edits are never silently discarded.
function buildCiliumValuesYaml() {
  const f = state.ciliumForm;
  const lines = [];
  lines.push(`cluster:`);
  lines.push(`  name: "${f.clusterName}"`);
  lines.push(`  id: ${f.clusterId}`);
  lines.push(`routingMode: "${f.routingMode}"`);
  if (f.routingMode === "tunnel") {
    lines.push(`tunnelProtocol: "${f.tunnelProtocol}"`);
  } else {
    lines.push(`autoDirectNodeRoutes: true`);
  }
  lines.push(`kubeProxyReplacement: ${f.kubeProxyReplacement}`);
  if (f.kubeProxyReplacement) {
    // Required once kube-proxy replacement is on and kube-proxy itself
    // isn't running - Cilium needs to know the API server address directly
    // instead of discovering it via the (now absent) kube-proxy-managed
    // Service. Get this wrong and cilium-agent won't come up at all.
    if (f.k8sServiceHost) lines.push(`k8sServiceHost: "${f.k8sServiceHost}"`);
    lines.push(`k8sServicePort: ${f.k8sServicePort}`);
  }
  lines.push(`ipam:`);
  lines.push(`  mode: "${f.ipamMode}"`);
  lines.push(`hubble:`);
  lines.push(`  enabled: ${f.hubbleEnabled}`);
  lines.push(`  relay:`);
  lines.push(`    enabled: ${f.hubbleEnabled && f.hubbleRelayEnabled}`);
  lines.push(`  ui:`);
  lines.push(`    enabled: ${f.hubbleEnabled && f.hubbleUiEnabled}`);
  lines.push(`encryption:`);
  lines.push(`  enabled: ${f.encryptionEnabled}`);
  if (f.encryptionEnabled) {
    lines.push(`  type: "${f.encryptionType}"`);
  }
  return lines.join("\n") + "\n";
}

function ciliumAuthPayload() {
  const f = state.ciliumForm;
  return {
    ssh_user: f.sshUser || null,
    auth_method: f.authMethod,
    ssh_password: f.authMethod === "password" ? f.sshPassword : null,
  };
}

function ciliumNeedsPassword() {
  const f = state.ciliumForm;
  if (f.authMethod === "password" && !f.sshPassword) {
    showToast("Enter a password, or switch to Public key auth.", "error");
    return true;
  }
  return false;
}

async function loadCilium() {
  content.innerHTML = `<div class="empty-state"><p>Checking Cilium status…</p></div>`;
  try {
    const data = await api(`/api/inventories/${state.inventory}/cilium/plan`);
    renderCilium(data);
  } catch (e) {
    content.innerHTML = "";
    showToast("Error: " + e.message, "error");
  }
}

async function pollCiliumRunning(previousSnapshot) {
  if (state.topTab !== "cilium") return;
  try {
    const freshData = await api(`/api/inventories/${state.inventory}/cilium/plan`);
    const snapshot = {
      install_running: freshData.install_running, install_log: freshData.install_log,
      uninstall_running: freshData.uninstall_running, uninstall_log: freshData.uninstall_log,
      connectivity_running: freshData.connectivity_running, connectivity_log: freshData.connectivity_log,
    };
    const changed = JSON.stringify(snapshot) !== JSON.stringify(previousSnapshot);
    if (changed) {
      preserveScroll(["ciliumInstallLog", "ciliumUninstallLog", "ciliumConnectivityLog"], () => renderCilium(freshData));
    } else if (freshData.install_running || freshData.uninstall_running || freshData.connectivity_running) {
      setTimeout(() => pollCiliumRunning(snapshot), 4000);
    }
  } catch (e) {
    // Transient - the next manual tab switch/reload will surface real errors.
  }
}

async function refreshCiliumVersions(selectEl, btn) {
  if (ciliumNeedsPassword()) return;
  const origText = btn.textContent;
  btn.disabled = true;
  btn.textContent = "Loading…";
  try {
    const res = await fetch(`/api/inventories/${state.inventory}/cilium/versions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(ciliumAuthPayload()),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.detail || res.statusText);
    selectEl.innerHTML = "";
    for (const v of data.versions) {
      const opt = document.createElement("option");
      opt.value = v;
      opt.textContent = v;
      selectEl.appendChild(opt);
    }
    if (data.versions.length) {
      state.ciliumForm.version = data.versions[0];
      selectEl.value = data.versions[0];
    }
    showToast(`Loaded ${data.versions.length} version(s).`, "success");
  } catch (e) {
    showToast("Error: " + e.message, "error");
  } finally {
    btn.disabled = false;
    btn.textContent = origText;
  }
}

function renderCiliumNodeTable(tableEl, nodes) {
  if (!nodes.length) {
    tableEl.innerHTML = `<div class="empty-state"><p>No cilium-agent pods found - is Cilium installed on this inventory?</p></div>`;
    return;
  }
  const rows = nodes.map((n) => `
    <tr>
      <td>${escapeHtml(n.node)}</td>
      <td>${n.ready ? "✅ Ready" : "❌ Not ready"}</td>
      <td>${escapeHtml(n.phase)}</td>
      <td>${escapeHtml(n.version || "?")}</td>
      <td>${n.restarts}</td>
      <td>${escapeHtml(n.started || "")}</td>
    </tr>`).join("");
  tableEl.innerHTML = `
    <table class="data-table">
      <thead><tr><th>Node</th><th>Status</th><th>Phase</th><th>Version</th><th>Restarts</th><th>Started</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
}

async function refreshCiliumNodeStatus(tableEl, btn) {
  if (ciliumNeedsPassword()) return;
  const origText = btn.textContent;
  btn.disabled = true;
  btn.textContent = "Loading…";
  try {
    const res = await fetch(`/api/inventories/${state.inventory}/cilium/node-status`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(ciliumAuthPayload()),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.detail || res.statusText);
    renderCiliumNodeTable(tableEl, data.nodes);
    showToast(`${data.nodes.length} node(s).`, "success");
  } catch (e) {
    showToast("Error: " + e.message, "error");
  } finally {
    btn.disabled = false;
    btn.textContent = origText;
  }
}

async function runCiliumInstall(logEl, btn) {
  const f = state.ciliumForm;
  if (ciliumNeedsPassword()) return;
  if (!f.version) {
    showToast("Pick a Cilium version first (Refresh versions).", "error");
    return;
  }
  if (!confirm(
    `Really install/upgrade Cilium ${f.version} on inventory "${state.inventory}"? ` +
    `This changes cluster networking - existing pods may briefly lose connectivity while cilium-agent restarts on every node.`
  )) return;
  const origText = btn.textContent;
  btn.disabled = true;
  btn.textContent = "Running…";
  logEl.style.display = "block";
  logEl.textContent = "";
  state.ciliumInstallLog = "";
  try {
    const res = await fetch(`/api/inventories/${state.inventory}/cilium/install`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...ciliumAuthPayload(),
        confirm: true,
        cilium_version: f.version,
        values_yaml: f.valuesYaml,
      }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.detail || res.statusText);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value, { stream: true });
      logEl.textContent += chunk;
      state.ciliumInstallLog += chunk;
      logEl.scrollTop = logEl.scrollHeight;
    }
    const code = parseExitCode(state.ciliumInstallLog);
    if (code === 0) {
      showToast("Cilium install/upgrade finished successfully.", "success");
    } else {
      showToast(`Cilium install/upgrade failed (exit code ${code}) - check the log.`, "error");
    }
  } catch (e) {
    showToast("Error: " + e.message, "error");
  } finally {
    btn.disabled = false;
    btn.textContent = origText;
  }
}

async function runCiliumUninstall(logEl, btn) {
  if (ciliumNeedsPassword()) return;
  const inv = state.inventory;
  if (!confirm(
    `Really COMPLETELY remove Cilium from inventory "${inv}"? ` +
    `This runs helm uninstall, then clears finalizers on and deletes every Cilium custom resource and CRD in the cluster - ` +
    `pods will lose networking until another CNI (or Cilium again) is installed. There is no undo.`
  )) return;
  if (prompt(`Type the inventory name ("${inv}") to confirm this irreversible removal:`) !== inv) {
    showToast("Cancelled - inventory name didn't match.", "error");
    return;
  }
  const origText = btn.textContent;
  btn.disabled = true;
  btn.textContent = "Removing…";
  logEl.style.display = "block";
  logEl.textContent = "";
  state.ciliumUninstallLog = "";
  try {
    const res = await fetch(`/api/inventories/${state.inventory}/cilium/uninstall`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...ciliumAuthPayload(), confirm: true }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.detail || res.statusText);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value, { stream: true });
      logEl.textContent += chunk;
      state.ciliumUninstallLog += chunk;
      logEl.scrollTop = logEl.scrollHeight;
    }
    const code = parseExitCode(state.ciliumUninstallLog);
    if (code === 0) {
      showToast("Cilium removed completely.", "success");
    } else {
      showToast(`Cilium removal hit a problem (exit code ${code}) - check the log.`, "error");
    }
  } catch (e) {
    showToast("Error: " + e.message, "error");
  } finally {
    btn.disabled = false;
    btn.textContent = origText;
  }
}

async function runCiliumConnectivityTest(logEl, btn) {
  if (ciliumNeedsPassword()) return;
  const origText = btn.textContent;
  btn.disabled = true;
  btn.textContent = "Running…";
  logEl.style.display = "block";
  logEl.textContent = "";
  state.ciliumConnectivityLog = "";
  try {
    const res = await fetch(`/api/inventories/${state.inventory}/cilium/connectivity-test`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(ciliumAuthPayload()),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.detail || res.statusText);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value, { stream: true });
      logEl.textContent += chunk;
      state.ciliumConnectivityLog += chunk;
      logEl.scrollTop = logEl.scrollHeight;
    }
    const code = parseExitCode(state.ciliumConnectivityLog);
    if (code === 0) {
      showToast("Cilium connectivity test passed.", "success");
    } else {
      showToast(`Cilium connectivity test found problems (exit code ${code}) - check the log.`, "error");
    }
  } catch (e) {
    showToast("Error: " + e.message, "error");
  } finally {
    btn.disabled = false;
    btn.textContent = origText;
  }
}

function renderCilium(data) {
  const f = state.ciliumForm;
  const wrap = document.createElement("div");

  const header = document.createElement("div");
  header.className = "file-header";
  header.innerHTML = `<h2>Cilium (Helm)</h2><span class="path">inventory/${state.inventory}</span>`;
  wrap.appendChild(header);

  const desc = document.createElement("div");
  desc.className = "file-desc";
  desc.textContent = "Installs/upgrades Cilium via Helm on this inventory's control-plane host, independent of whichever CNI (if any) cluster.yml itself set up.";
  wrap.appendChild(desc);

  const dangerBanner = document.createElement("div");
  dangerBanner.className = "ops-note danger";
  dangerBanner.textContent = "This changes real cluster networking. If another CNI is already active on this cluster, installing Cilium alongside it can conflict - make sure that's intended before running this.";
  wrap.appendChild(dangerBanner);

  // --- auth fields (same shape/pattern as the Installation tab) ---
  const authForm = document.createElement("div");
  authForm.className = "ops-fields";

  const userInput = document.createElement("input");
  userInput.type = "text";
  userInput.placeholder = "(defaults to inventory's ansible_user)";
  userInput.value = f.sshUser;
  userInput.addEventListener("input", () => { f.sshUser = userInput.value; });

  const keyRadio = document.createElement("input");
  keyRadio.type = "radio";
  keyRadio.name = "ciliumAuthMethod";
  keyRadio.checked = f.authMethod === "publickey";
  const passRadio = document.createElement("input");
  passRadio.type = "radio";
  passRadio.name = "ciliumAuthMethod";
  passRadio.checked = f.authMethod === "password";

  const passwordInput = document.createElement("input");
  passwordInput.type = "password";
  passwordInput.placeholder = "SSH + sudo password";
  passwordInput.value = f.sshPassword;
  passwordInput.disabled = f.authMethod !== "password";
  passwordInput.addEventListener("input", () => { f.sshPassword = passwordInput.value; });

  keyRadio.addEventListener("change", () => { f.authMethod = "publickey"; passwordInput.disabled = true; });
  passRadio.addEventListener("change", () => { f.authMethod = "password"; passwordInput.disabled = false; });

  authForm.appendChild(opsField("SSH user (-u)", userInput));
  authForm.appendChild(opsField("Public key (uses this host's mounted SSH keys)", keyRadio));
  authForm.appendChild(opsField("Password", passRadio));
  authForm.appendChild(opsField("Password value", passwordInput));
  wrap.appendChild(authForm);

  // --- version selector ---
  const versionRow = document.createElement("div");
  versionRow.className = "ops-fields";
  const versionSelect = document.createElement("select");
  if (f.version) {
    const opt = document.createElement("option");
    opt.value = f.version;
    opt.textContent = f.version;
    versionSelect.appendChild(opt);
  }
  versionSelect.addEventListener("change", () => { f.version = versionSelect.value; });
  const refreshVersionsBtn = document.createElement("button");
  refreshVersionsBtn.className = "btn-secondary";
  refreshVersionsBtn.textContent = "🔄 Refresh versions";
  refreshVersionsBtn.addEventListener("click", () => refreshCiliumVersions(versionSelect, refreshVersionsBtn));
  versionRow.appendChild(opsField("Cilium chart version", versionSelect));
  const versionBtnRow = document.createElement("div");
  versionBtnRow.appendChild(refreshVersionsBtn);
  versionRow.appendChild(versionBtnRow);
  wrap.appendChild(versionRow);

  // --- curated config fields ---
  const cfgForm = document.createElement("div");
  cfgForm.className = "ops-fields";

  const routingSelect = document.createElement("select");
  for (const [val, label] of [["tunnel", "Tunnel (VXLAN/Geneve)"], ["native", "Native routing"]]) {
    const opt = document.createElement("option");
    opt.value = val; opt.textContent = label; opt.selected = f.routingMode === val;
    routingSelect.appendChild(opt);
  }
  routingSelect.addEventListener("change", () => { f.routingMode = routingSelect.value; tunnelProtoField.style.display = f.routingMode === "tunnel" ? "" : "none"; });

  const tunnelProtoSelect = document.createElement("select");
  for (const val of ["vxlan", "geneve"]) {
    const opt = document.createElement("option");
    opt.value = val; opt.textContent = val; opt.selected = f.tunnelProtocol === val;
    tunnelProtoSelect.appendChild(opt);
  }
  tunnelProtoSelect.addEventListener("change", () => { f.tunnelProtocol = tunnelProtoSelect.value; });
  const tunnelProtoField = opsField("Tunnel protocol", tunnelProtoSelect);
  tunnelProtoField.style.display = f.routingMode === "tunnel" ? "" : "none";

  const kubeProxyCheckbox = document.createElement("input");
  kubeProxyCheckbox.type = "checkbox";
  kubeProxyCheckbox.checked = f.kubeProxyReplacement;
  kubeProxyCheckbox.addEventListener("change", () => {
    f.kubeProxyReplacement = kubeProxyCheckbox.checked;
    k8sHostField.style.display = f.kubeProxyReplacement ? "" : "none";
    k8sPortField.style.display = f.kubeProxyReplacement ? "" : "none";
  });

  const k8sHostInput = document.createElement("input");
  k8sHostInput.type = "text";
  k8sHostInput.placeholder = "e.g. 10.20.30.11 or your API server LB VIP";
  k8sHostInput.value = f.k8sServiceHost;
  k8sHostInput.addEventListener("input", () => { f.k8sServiceHost = k8sHostInput.value; });
  const k8sHostField = opsField("Kubernetes API host (required if kube-proxy replacement is on)", k8sHostInput);
  k8sHostField.style.display = f.kubeProxyReplacement ? "" : "none";

  const k8sPortInput = document.createElement("input");
  k8sPortInput.type = "text";
  k8sPortInput.value = f.k8sServicePort;
  k8sPortInput.addEventListener("input", () => { f.k8sServicePort = k8sPortInput.value; });
  const k8sPortField = opsField("Kubernetes API port", k8sPortInput);
  k8sPortField.style.display = f.kubeProxyReplacement ? "" : "none";

  const hubbleCheckbox = document.createElement("input");
  hubbleCheckbox.type = "checkbox";
  hubbleCheckbox.checked = f.hubbleEnabled;
  hubbleCheckbox.addEventListener("change", () => { f.hubbleEnabled = hubbleCheckbox.checked; });

  const hubbleRelayCheckbox = document.createElement("input");
  hubbleRelayCheckbox.type = "checkbox";
  hubbleRelayCheckbox.checked = f.hubbleRelayEnabled;
  hubbleRelayCheckbox.addEventListener("change", () => { f.hubbleRelayEnabled = hubbleRelayCheckbox.checked; });

  const hubbleUiCheckbox = document.createElement("input");
  hubbleUiCheckbox.type = "checkbox";
  hubbleUiCheckbox.checked = f.hubbleUiEnabled;
  hubbleUiCheckbox.addEventListener("change", () => { f.hubbleUiEnabled = hubbleUiCheckbox.checked; });

  const encryptionCheckbox = document.createElement("input");
  encryptionCheckbox.type = "checkbox";
  encryptionCheckbox.checked = f.encryptionEnabled;
  encryptionCheckbox.addEventListener("change", () => { f.encryptionEnabled = encryptionCheckbox.checked; encryptionTypeField.style.display = f.encryptionEnabled ? "" : "none"; });

  const encryptionTypeSelect = document.createElement("select");
  for (const val of ["wireguard", "ipsec"]) {
    const opt = document.createElement("option");
    opt.value = val; opt.textContent = val; opt.selected = f.encryptionType === val;
    encryptionTypeSelect.appendChild(opt);
  }
  encryptionTypeSelect.addEventListener("change", () => { f.encryptionType = encryptionTypeSelect.value; });
  const encryptionTypeField = opsField("Encryption type", encryptionTypeSelect);
  encryptionTypeField.style.display = f.encryptionEnabled ? "" : "none";

  const ipamSelect = document.createElement("select");
  for (const [val, label] of [["cluster-pool", "Cluster Pool (Cilium-managed)"], ["kubernetes", "Kubernetes (node podCIDR)"]]) {
    const opt = document.createElement("option");
    opt.value = val; opt.textContent = label; opt.selected = f.ipamMode === val;
    ipamSelect.appendChild(opt);
  }
  ipamSelect.addEventListener("change", () => { f.ipamMode = ipamSelect.value; });

  const clusterNameInput = document.createElement("input");
  clusterNameInput.type = "text";
  clusterNameInput.value = f.clusterName;
  clusterNameInput.addEventListener("input", () => { f.clusterName = clusterNameInput.value; });

  const clusterIdInput = document.createElement("input");
  clusterIdInput.type = "text";
  clusterIdInput.value = f.clusterId;
  clusterIdInput.addEventListener("input", () => { f.clusterId = clusterIdInput.value; });

  cfgForm.appendChild(opsField("Routing mode", routingSelect));
  cfgForm.appendChild(tunnelProtoField);
  cfgForm.appendChild(opsField("kube-proxy replacement", kubeProxyCheckbox));
  cfgForm.appendChild(k8sHostField);
  cfgForm.appendChild(k8sPortField);
  cfgForm.appendChild(opsField("IPAM mode", ipamSelect));
  cfgForm.appendChild(opsField("Hubble (observability)", hubbleCheckbox));
  cfgForm.appendChild(opsField("Hubble Relay", hubbleRelayCheckbox));
  cfgForm.appendChild(opsField("Hubble UI", hubbleUiCheckbox));
  cfgForm.appendChild(opsField("Encryption", encryptionCheckbox));
  cfgForm.appendChild(encryptionTypeField);
  cfgForm.appendChild(opsField("Cluster name", clusterNameInput));
  cfgForm.appendChild(opsField("Cluster ID", clusterIdInput));
  wrap.appendChild(cfgForm);

  // --- values.yaml editor (the actual source of truth for install) ---
  const valuesDesc = document.createElement("div");
  valuesDesc.className = "file-desc";
  valuesDesc.textContent = "values.yaml - this exact content is what gets installed, not the fields above directly. \"Generate\" fills it in from the fields; hand-edit freely afterward.";
  wrap.appendChild(valuesDesc);

  const generateBtn = document.createElement("button");
  generateBtn.className = "btn-secondary";
  generateBtn.textContent = "⚙ Generate values.yaml from fields";
  generateBtn.style.marginBottom = "10px";

  const valuesTextarea = document.createElement("textarea");
  valuesTextarea.className = "raw-editor";
  valuesTextarea.style.minHeight = "220px";
  valuesTextarea.value = f.valuesYaml || buildCiliumValuesYaml();
  f.valuesYaml = valuesTextarea.value;
  valuesTextarea.addEventListener("input", () => { f.valuesYaml = valuesTextarea.value; });

  generateBtn.addEventListener("click", () => {
    if (f.valuesYaml && !confirm("Overwrite the values.yaml editor with fields generated from the form above? Any manual edits will be lost.")) return;
    const generated = buildCiliumValuesYaml();
    valuesTextarea.value = generated;
    f.valuesYaml = generated;
  });

  wrap.appendChild(generateBtn);
  wrap.appendChild(valuesTextarea);

  // --- install/upgrade ---
  const installRow = document.createElement("div");
  installRow.style.marginTop = "16px";
  const installBtn = document.createElement("button");
  installBtn.className = "btn-danger";
  installBtn.textContent = "⬆ Install / Upgrade Cilium";
  if (data.install_running) {
    installBtn.disabled = true;
    installBtn.textContent = "Running… (started elsewhere)";
  }
  const installLogEl = document.createElement("pre");
  installLogEl.id = "ciliumInstallLog";
  installLogEl.className = "raw-editor ops-cmd-output offline-log";
  const priorInstallLog = data.install_log || state.ciliumInstallLog;
  state.ciliumInstallLog = priorInstallLog || "";
  installLogEl.textContent = priorInstallLog || "";
  installLogEl.style.display = priorInstallLog ? "block" : "none";
  installLogEl.style.marginTop = "10px";
  installBtn.addEventListener("click", () => runCiliumInstall(installLogEl, installBtn));
  installRow.appendChild(installBtn);
  wrap.appendChild(installRow);
  wrap.appendChild(installLogEl);

  // --- uninstall (complete removal) ---
  const uninstallDesc = document.createElement("div");
  uninstallDesc.className = "file-desc";
  uninstallDesc.textContent = "Completely removes Cilium: helm uninstall, then clears finalizers on and deletes every Cilium custom resource and CRD - nothing left stuck Terminating.";
  uninstallDesc.style.marginTop = "16px";
  wrap.appendChild(uninstallDesc);

  const uninstallBanner = document.createElement("div");
  uninstallBanner.className = "ops-note danger";
  uninstallBanner.textContent = "Irreversible. Pods lose networking entirely until another CNI (or Cilium again) is installed.";
  wrap.appendChild(uninstallBanner);

  const uninstallRow = document.createElement("div");
  const uninstallBtn = document.createElement("button");
  uninstallBtn.className = "btn-danger";
  uninstallBtn.textContent = "🗑 Remove Cilium (complete)";
  if (data.uninstall_running) {
    uninstallBtn.disabled = true;
    uninstallBtn.textContent = "Removing… (started elsewhere)";
  }
  const uninstallLogEl = document.createElement("pre");
  uninstallLogEl.id = "ciliumUninstallLog";
  uninstallLogEl.className = "raw-editor ops-cmd-output offline-log";
  const priorUninstallLog = data.uninstall_log || state.ciliumUninstallLog;
  state.ciliumUninstallLog = priorUninstallLog || "";
  uninstallLogEl.textContent = priorUninstallLog || "";
  uninstallLogEl.style.display = priorUninstallLog ? "block" : "none";
  uninstallLogEl.style.marginTop = "10px";
  uninstallBtn.addEventListener("click", () => runCiliumUninstall(uninstallLogEl, uninstallBtn));
  uninstallRow.appendChild(uninstallBtn);
  wrap.appendChild(uninstallRow);
  wrap.appendChild(uninstallLogEl);

  // --- connectivity test ---
  const connDesc = document.createElement("div");
  connDesc.className = "file-desc";
  connDesc.textContent = "Runs the real `cilium connectivity test` - use it before an upgrade (baseline) and after (verify nothing broke), or any time.";
  connDesc.style.marginTop = "16px";
  wrap.appendChild(connDesc);

  const connRow = document.createElement("div");
  const connBtn = document.createElement("button");
  connBtn.className = "btn-secondary";
  connBtn.textContent = "🔌 Test connectivity";
  if (data.connectivity_running) {
    connBtn.disabled = true;
    connBtn.textContent = "Running… (started elsewhere)";
  }
  const connLogEl = document.createElement("pre");
  connLogEl.id = "ciliumConnectivityLog";
  connLogEl.className = "raw-editor ops-cmd-output offline-log";
  const priorConnLog = data.connectivity_log || state.ciliumConnectivityLog;
  state.ciliumConnectivityLog = priorConnLog || "";
  connLogEl.textContent = priorConnLog || "";
  connLogEl.style.display = priorConnLog ? "block" : "none";
  connLogEl.style.marginTop = "10px";
  connBtn.addEventListener("click", () => runCiliumConnectivityTest(connLogEl, connBtn));
  connRow.appendChild(connBtn);
  wrap.appendChild(connRow);
  wrap.appendChild(connLogEl);

  // --- per-node status ---
  const nodeDesc = document.createElement("div");
  nodeDesc.className = "file-desc";
  nodeDesc.textContent = "Per-node cilium-agent status.";
  nodeDesc.style.marginTop = "16px";
  wrap.appendChild(nodeDesc);

  const nodeRow = document.createElement("div");
  const nodeBtn = document.createElement("button");
  nodeBtn.className = "btn-secondary";
  nodeBtn.textContent = "🔄 Refresh node status";
  const nodeTable = document.createElement("div");
  nodeTable.style.marginTop = "10px";
  nodeBtn.addEventListener("click", () => refreshCiliumNodeStatus(nodeTable, nodeBtn));
  nodeRow.appendChild(nodeBtn);
  wrap.appendChild(nodeRow);
  wrap.appendChild(nodeTable);

  content.innerHTML = "";
  content.appendChild(wrap);

  if (data.install_running || data.uninstall_running || data.connectivity_running) {
    setTimeout(() => pollCiliumRunning({
      install_running: data.install_running, install_log: data.install_log,
      uninstall_running: data.uninstall_running, uninstall_log: data.uninstall_log,
      connectivity_running: data.connectivity_running, connectivity_log: data.connectivity_log,
    }), 4000);
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
