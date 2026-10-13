<div dir="rtl">

# راهنمای کامل عملیات کلاستر: نصب، اضافه و حذف نود، Reset، Scale، Upgrade و بکاپ etcd

این راهنما همه‌ی عملیات روزمره روی کلاستر را پوشش می‌دهد، هم از **webui** و هم از **خط فرمان (CLI)**. دستورهای تب **Cluster Operations** در webui دقیقاً همین‌هایی است که این‌جا آمده. آن تب فقط دستور را **می‌سازد** و اجرا با خود شماست.

> **محیط ایزوله:** اگر نودها اینترنت ندارند، اول [راهنمای نصب ایزوله](isolated-install-fa.md) را ببینید (مخزن‌های محلی، `offline.yml`، apt نودها).

## فهرست

1. [دستورها کجا و چطور اجرا می‌شوند](#run)
2. [نصب کلاستر](#install)
3. [اضافه کردن نود worker](#add-worker)
4. [اضافه کردن نود control plane](#add-cp)
5. [اضافه کردن نود etcd](#add-etcd)
6. [حذف نود](#remove)
7. [حذف اولین control plane](#remove-first-cp)
8. [Scale](#scale)
9. [Reset (حذف کلاستر)](#reset)
10. [Upgrade کلاستر](#upgrade)
11. [kube-proxy و Cilium](#kube-proxy)
12. [بکاپ زمان‌بندی‌شده‌ی etcd](#etcd-backup)
13. [بررسی سلامت کلاستر](#verify)
14. [خطاهای رایج](#errors)

---

<a id="run"></a>

## ۱. دستورها کجا و چطور اجرا می‌شوند

همه‌ی دستورهای `ansible-playbook` در **کانتینر webui** اجرا می‌شوند. Ansible، collectionها و خود kubespray آن‌جا آماده‌اند و نیازی به نصب چیزی روی ماشین نیست:

<div dir="ltr">

```bash
ssh devops@<webui-server>                      # e.g. 192.168.12.21
docker exec -it kubespray-webui-webui-1 bash
cd /kubespray
```

</div>

در همه‌ی مثال‌ها:

| بخش | معنی |
|---|---|
| `-i inventory/afshin/inventory.yml` | inventory کلاستر. به‌جای `afshin` نام inventory خودتان را بگذارید |
| `-b` | اجرا با sudo روی نودها |
| `-u devops` | کاربر SSH روی نودها |
| `-k -K` | رمز SSH و رمز sudo را می‌پرسد. اگر کلید SSH دارید و sudo بدون رمز است، این دو را حذف کنید |
| `-v` | لاگ مفصل‌تر |
| `--limit=<نود>` | اجرا فقط روی همان نودها |

**قانون طلایی:** هر تغییری در نودها، **اول در inventory** انجام می‌شود:
- **webui:** تب **Files** ← Hosts & Inventory
- **دستی:** فایل `inventory/<name>/inventory.yml`

بعد playbook را اجرا کنید.

> **اسم نود:** همان اسمی است که در inventory آمده (مثلاً `worker4`)، نه IP آن.

---

<a id="install"></a>

## ۲. نصب کلاستر

**از webui:** تب **Installation**، به این ترتیب:
1. **🔌 Check connectivity:** باید از همه‌ی نودها `pong` برگردد.
2. **📦 Point node apt at offline repo:** فقط در محیط ایزوله.
3. **▶ Run cluster install**
4. **✅ Verify cluster**

**از CLI:**

<div dir="ltr">

```bash
ansible-playbook -i inventory/afshin/inventory.yml cluster.yml -b -v -u devops -k -K
```

</div>

**نکته‌ها:**
- **اجرای دوباره امن است.** اگر نصب وسط کار خطا داد، بعد از رفع مشکل همان دستور را دوباره بزنید. کار از جایی که لازم است ادامه پیدا می‌کند.
- **CNI:** وقتی `kube_network_plugin: none` است، شبکه‌ی کلاستر (CNI) نصب نمی‌شود و نودها تا نصب Cilium (تب **Cilium**) در حالت `NotReady` می‌مانند. این طبیعی است.

---

<a id="add-worker"></a>

## ۳. اضافه کردن نود worker

**۱. inventory:** نود جدید را در `all.hosts` تعریف کنید و به گروه `kube_node` اضافه کنید:

<div dir="ltr">

```yaml
all:
  hosts:
    worker4:
      ansible_host: 192.168.12.26
      ip: 192.168.12.26
      ansible_user: devops
  children:
    kube_node:
      hosts:
        worker4: null
```

</div>

**۲. فقط در محیط ایزوله:** apt نود جدید را به مخزن محلی وصل کنید:

<div dir="ltr">

```bash
ansible-playbook -i inventory/afshin/inventory.yml /app/playbooks/offline-apt.yml -b -u devops -k -K \
  -e offline_apt_mode=enable --limit=worker4
```

</div>

**۳. اجرا.** در webui این مسیر را بروید: **Cluster Operations** ← **Add node** ← نقش: **Worker node**. اسم نود را وارد کنید و گزینه‌ی Refresh facts را روشن بگذارید.

<div dir="ltr">

```bash
ansible-playbook -i inventory/afshin/inventory.yml facts.yml -b -v -u devops -k -K
ansible-playbook -i inventory/afshin/inventory.yml scale.yml -b -v -u devops -k -K --limit=worker4
```

</div>

- `facts.yml` (**بدون** `--limit`) اطلاعات همه‌ی نودها را به‌روز می‌کند. وقتی `scale.yml` را با `--limit` اجرا می‌کنید، این کار لازم است.
- `--limit` باعث می‌شود بقیه‌ی نودها دست نخورند. برای چند نود: `--limit=worker4:worker5`

**۴. بررسی:** روی master1 دستور `kubectl get nodes` را بزنید، یا در webui دکمه‌ی **Verify cluster** را.

---

<a id="add-cp"></a>

## ۴. اضافه کردن نود control plane

**۱. inventory:** نود جدید را **به آخر** گروه `kube_control_plane` اضافه کنید. اگر قرار است etcd هم روی آن باشد، به گروه `etcd` هم اضافه کنید.

> ⚠️ نود جدید را **هرگز اول** لیست `kube_control_plane` نگذارید. kubespray این را پشتیبانی نمی‌کند و playbook شکست می‌خورد.

**۲.** در محیط ایزوله، apt نود را مثل بخش ۳ وصل کنید.

**۳. اجرا.** با **`cluster.yml`**، نه `scale.yml`. در webui: **Add node** ← نقش: **Control plane node**.

<div dir="ltr">

```bash
ansible-playbook -i inventory/afshin/inventory.yml cluster.yml -b -v -u devops -k -K --limit=kube_control_plane
```

</div>

**۴. ری‌استارت nginx-proxy روی همه‌ی نودها.** این pod یک proxy محلی جلوی API server است. kubespray تنظیماتش را عوض می‌کند، ولی تا ری‌استارت نشود تنظیمات جدید را نمی‌خواند:

<div dir="ltr">

```bash
ansible -i inventory/afshin/inventory.yml all -b -u devops -k -K -m shell \
  -a "crictl ps | grep nginx-proxy | awk '{print \$1}' | xargs -r crictl stop"
```

</div>

---

<a id="add-etcd"></a>

## ۵. اضافه کردن نود etcd

- **تعداد نودهای etcd همیشه باید فرد باشد** (۱، ۳ یا ۵). پس یا دو نود اضافه کنید، یا همزمان یکی را جایگزین کنید.
- اگر نودی که می‌خواهید etcd شود همین الان worker یا control plane است، **اول آن را حذف کنید** (بخش ۶).

**۱. inventory:** نود را به گروه `etcd` اضافه کنید.

**۲. اجرا.** در webui: **Add node** ← نقش: **etcd node**.

<div dir="ltr">

```bash
ansible-playbook -i inventory/afshin/inventory.yml cluster.yml -b -v -u devops -k -K \
  --limit=etcd,kube_control_plane -e ignore_assert_errors=yes
# then refresh the etcd configuration on the whole cluster
ansible-playbook -i inventory/afshin/inventory.yml upgrade-cluster.yml -b -v -u devops -k -K \
  --limit=etcd,kube_control_plane -e ignore_assert_errors=yes
```

</div>

- اگر چند نود etcd را با هم اضافه می‌کنید، `-e etcd_retries=10` را هم بگذارید.

**۳.** روی هر control plane، در `/etc/kubernetes/manifests/kube-apiserver.yaml` چک کنید که آدرس نودهای جدید etcd در پارامتر `--etcd-servers=` آمده باشد.

---

<a id="remove"></a>

## ۶. حذف نود (worker، control plane یا etcd)

**۱. اجرا، در حالی که نود هنوز در inventory است.** در webui: **Cluster Operations** ← **Remove node**.

<div dir="ltr">

```bash
ansible-playbook -i inventory/afshin/inventory.yml remove-node.yml -b -v -u devops -k -K -e node=worker4
```

</div>

**اگر نود خاموش است یا در دسترس نیست،** در webui گزینه‌ی **Node is offline / unreachable** را بزنید، یا در CLI این دو را اضافه کنید:

<div dir="ltr">

```bash
-e reset_nodes=false -e allow_ungraceful_removal=true
```

</div>

**۲.** بعد از اتمام، نود را **از inventory پاک کنید.**

**۳. اگر نود عضو etcd بود:**
- `cluster.yml` را دوباره اجرا کنید تا تنظیمات روی نودهای باقی‌مانده با لیست جدید etcd ساخته شود.
- روی هر control plane، از `--etcd-servers=` در `kube-apiserver.yaml` آدرس نود حذف‌شده را بردارید.

**۴.** نود را خاموش کنید.

---

<a id="remove-first-cp"></a>

## ۷. حذف اولین control plane (اولین نود etcd)

اولین نود لیست `kube_control_plane` و `etcd` را **نمی‌شود مستقیم حذف کرد.** این مراحل را انجام دهید:

1. **جابه‌جایی:** در inventory ترتیب نودها را عوض کنید تا آن نود اول نباشد. این کار را در هر سه گروه `kube_control_plane`، `etcd` و `kube_node` انجام دهید.
2. **اعمال ترتیب جدید:** `cluster.yml` یا `upgrade-cluster.yml` را اجرا کنید.
3. **حذف:** `remove-node.yml -e node=<نام>` را اجرا کنید (بخش ۶).
4. **اصلاح cluster-info:** `kubectl edit cm -n kube-public cluster-info`. در فیلد `server`، آدرس نود قدیمی را با آدرس یک control plane زنده عوض کنید.
5. **اضافه کردن نود جدید (اگر لازم است):** `cluster.yml --limit=kube_control_plane` را اجرا کنید.

---

<a id="scale"></a>

## ۸. Scale

`scale.yml` **فقط worker** اضافه یا به‌روز می‌کند. برای control plane و etcd به بخش‌های ۴ و ۵ مراجعه کنید.

در webui: **Cluster Operations** ← **Scale**.

<div dir="ltr">

```bash
ansible-playbook -i inventory/afshin/inventory.yml facts.yml -b -v -u devops -k -K
ansible-playbook -i inventory/afshin/inventory.yml scale.yml -b -v -u devops -k -K --limit=worker4:worker5
```

</div>

بدون `--limit`، همه‌ی workerها بررسی و به‌روز می‌شوند. این کار امن است، ولی بیشتر طول می‌کشد.

---

<a id="reset"></a>

## ۹. Reset (حذف کلاستر)

> ⚠️ **غیرقابل برگشت.** reset روی نودهای هدف این کارها را انجام می‌دهد:
> - `kubeadm reset`
> - پاک کردن داده‌ی **etcd** (همه‌ی منابع کلاستر)
> - پاک کردن kubelet، containerd و تنظیمات CNI
> - پاک کردن قوانین iptables و ipvs
>
> **قبل از آن از etcd بکاپ بگیرید** (بخش ۱۲). reset دست به inventory و `offline.yml` و apt نودها نمی‌زند.

در webui: **Cluster Operations** ← **Reset**. محدوده را مشخص کنید: کل کلاستر یا نودهای مشخص.

**کل کلاستر:**

<div dir="ltr">

```bash
ansible-playbook -i inventory/afshin/inventory.yml reset.yml -b -v -u devops -k -K
```

</div>

- playbook قبل از شروع می‌پرسد مطمئن هستید یا نه. باید `yes` تایپ کنید.
- برای رد کردن این سؤال: `-e reset_confirmation=yes`

**فقط نودهای مشخص:**

<div dir="ltr">

```bash
ansible-playbook -i inventory/afshin/inventory.yml reset.yml -b -v -u devops -k -K --limit=worker2:worker3
```

</div>

**بعد از reset:** برای نصب دوباره، بخش ۲ را ببینید.

> اگر روی یکی از نودها **Docker** هم برای کار دیگری نصب است و از همان containerd استفاده می‌کند، reset آن containerd را متوقف و حذف می‌کند و Docker هم از کار می‌افتد. قبل از reset چک کنید.

---

<a id="upgrade"></a>

## ۱۰. Upgrade کلاستر

1. در تب **Kubespray Version**، نسخه‌ی جدید kubespray را checkout کنید، یا در inventory مقدار `kube_version` را عوض کنید.
2. **محیط ایزوله:** قبل از رفتن به محیط ایزوله، همه‌ی مرحله‌های **Offline Install** را برای نسخه‌ی جدید دوباره اجرا کنید (لیست‌ها، فایل‌ها، imageها) و بعد **Check readiness** را بزنید. نسخه‌ی جدید فایل‌ها و imageهای جدید لازم دارد.
3. Upgrade را اجرا کنید. این کار نودها را یکی‌یکی drain و به‌روز می‌کند:

<div dir="ltr">

```bash
ansible-playbook -i inventory/afshin/inventory.yml upgrade-cluster.yml -b -v -u devops -k -K
```

</div>

> اگر نسخه‌ی جدید kubespray نسخه‌ی دیگری از Ansible می‌خواهد (`requirements.txt`)، image مربوط به webui هم باید با همان نسخه دوباره build شود.

---

<a id="kube-proxy"></a>

## ۱۱. kube-proxy و Cilium

`kube_network_plugin: none` فقط یعنی kubespray **CNI نصب نکند.** **kube-proxy جداست** و آن را خود `kubeadm` نصب می‌کند، مگر این‌که در `group_vars/k8s_cluster/k8s-cluster.yml` این خط را داشته باشید:

<div dir="ltr">

```yaml
kube_proxy_remove: true
```

</div>

با این تنظیم kubespray فاز `addon/kube-proxy` را در init، join و upgrade رد می‌کند. بعد در تب **Cilium**:
1. گزینه‌ی **kube-proxy replacement** را روشن کنید.
2. **API server host/port** را بدهید (مثلاً IP مربوط به master1 و `6443`).

**حذف kube-proxy از کلاستری که قبلاً نصب شده.** `kube_proxy_remove` kube-proxy موجود را حذف نمی‌کند. این را **دقیقاً قبل از نصب Cilium با kube-proxy replacement** انجام دهید:

<div dir="ltr">

```bash
# on master1
kubectl -n kube-system delete daemonset kube-proxy
kubectl -n kube-system delete configmap kube-proxy
# on every node: remove the iptables rules kube-proxy left behind
ansible -i inventory/afshin/inventory.yml all -b -u devops -k -K -m shell \
  -a "iptables-save | grep -v KUBE | iptables-restore"
```

</div>

> اگر Cilium را در حالت عادی می‌خواهید (`kubeProxyReplacement: false`)، kube-proxy باید بماند و `kube_proxy_remove` را نگذارید.

---

<a id="etcd-backup"></a>

## ۱۲. بکاپ زمان‌بندی‌شده‌ی etcd

یک systemd timer روی همه‌ی نودهای etcd نصب می‌شود که در فاصله‌های مشخص از etcd snapshot می‌گیرد و بکاپ‌های قدیمی‌تر از تعداد تعیین‌شده را پاک می‌کند.

در webui: **Cluster Operations** ← **Backup etcd** ← زمان‌بندی، تعداد نگهداری و مسیر.

<div dir="ltr">

```bash
ansible-playbook -i inventory/afshin/inventory.yml extra_playbooks/etcd-backup-schedule.yml -b -v -u devops -k -K \
  -e etcd_backup_schedule="*-*-* 03:00:00" \
  -e etcd_backup_retention_count=7 \
  -e etcd_backup_prefix=/var/backups
```

</div>

| زمان‌بندی (`etcd_backup_schedule`) | معنی |
|---|---|
| `*-*-* 03:00:00` | هر روز ساعت ۳ |
| `*-*-* 0/6:00:00` | هر ۶ ساعت |
| `*-*-* 0/12:00:00` | هر ۱۲ ساعت |
| `weekly` | هفته‌ای یک بار |

- **تغییر تنظیمات:** با اجرای دوباره، زمان‌بندی و تعداد نگهداری عوض می‌شوند.
- **بررسی روی نود etcd:** `systemctl list-timers etcd-snapshot-backup.timer` و `ls -lh /var/backups`
- **بکاپ دستی فوری:** `sudo systemctl start etcd-snapshot-backup.service`
- **کپی متمرکز:** سرویس `backup-sync` در docker-compose مربوط به webui بکاپ‌ها را از نودها می‌گیرد و در RustFS (bucket `etcd-backups`) نگه می‌دارد.

---

<a id="verify"></a>

## ۱۳. بررسی سلامت کلاستر

**از webui:** تب **Installation** ← **✅ Verify cluster**. همه‌ی نودها باید `Ready` باشند و همه‌ی podها `Running` یا `Succeeded`.

**از CLI**، روی master1:

<div dir="ltr">

```bash
sudo kubectl --kubeconfig /etc/kubernetes/admin.conf get nodes -o wide
sudo kubectl --kubeconfig /etc/kubernetes/admin.conf get pods -A
```

</div>

---

<a id="errors"></a>

## ۱۴. خطاهای رایج

| خطا | علت | راه حل |
|---|---|---|
| `server gave HTTP response to HTTPS client` موقع pull | در `offline.yml`، `registry_host` با mirrorهای containerd یکی نیست (مثلاً آدرس دستی عوض شده) | Offline Install ← **Point kubespray at these repos** با آدرس درست، بعد Check readiness و نصب دوباره |
| `i/o timeout` به :5000 یا :8080 | نودها به سرور webui و مخزن‌ها نمی‌رسند (شبکه، فایروال، یا IP داخلی WSL) | دسترسی شبکه را درست کنید. راهنمای ایزوله، بخش ۱ |
| `Unable to locate package` | apt نود به مخزن آفلاین وصل نیست، یا نسخه‌ی اوبونتو فرق دارد | **Point node apt at offline repo**، و مرحله‌ی OS packages با نسخه‌ی درست |
| `UNREACHABLE` در Check connectivity | کاربر، رمز یا کلید SSH اشتباه است | `-u`، رمز یا کلید را درست کنید. هر نود را با `ansible_user` خودش در inventory چک کنید |
| `Group 'etcd' cannot be empty` | گروه etcd در inventory خالی است | حداقل یک نود (تعداد فرد) به `etcd` اضافه کنید |
| نود `NotReady` بعد از نصب | CNI روی `none` است و هنوز Cilium نصب نشده | تب Cilium ← نصب |
| کلاستر کار می‌کند ولی kube-proxy هم هست | `kube_proxy_remove` تنظیم نشده بود | بخش ۱۱ |
| control plane جدید وصل نمی‌شود | آن را اول لیست گذاشته‌اید یا با `scale.yml` اجرا کرده‌اید | آخر لیست بگذارید و با `cluster.yml --limit=kube_control_plane` اجرا کنید (بخش ۴) |

</div>
