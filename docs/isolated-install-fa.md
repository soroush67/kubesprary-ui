<div dir="rtl">

# نصب Kubernetes در محیط ایزوله (بدون اینترنت)

**روش کار:** همه‌ی آماده‌سازی **اینجا**، روی ماشینی که اینترنت دارد، انجام می‌شود. بعد ماشین خاموش می‌شود و در محیط ایزوله بالا می‌آید. آنجا با `docker-compose up` همه‌ی مخزن‌ها آماده‌اند و Kubernetes و Cilium **بدون هیچ دسترسی به اینترنت** نصب می‌شوند.

| مخزن روی همین ماشین | پورت | محتوا |
|---|---|---|
| `offline-registry` | 5000 | همه‌ی imageهای kubespray و Cilium |
| `offline-files` | 8080 | kubeadm، kubelet، containerd، etcd، cni، helm، cilium-cli، chart مربوط به Cilium و… |
| `offline-apt` | 8081 | پکیج‌های اوبونتو برای نودها، با همه‌ی وابستگی‌ها |
| `offline-pip` | 8082 | پکیج‌های Python |

---

## ۱. مهم‌تر از همه: نودها باید به این ماشین برسند

نودها از این چهار پورت دانلود می‌کنند، پس **آدرسی که در `offline.yml` می‌نویسید باید از روی نودها قابل دسترس باشد.**

اگر این ماشین **WSL2 روی ویندوز** است، آدرس داخلی WSL (مثلاً `172.22.120.105`) از روی شبکه‌ی نودها **قابل دسترس نیست.** خطای مربوط به آن این است:
`dial tcp 172.22.120.105:5000: i/o timeout`

یکی از این دو راه را انجام دهید:

**راه ۱ (پیشنهادی): حالت شبکه‌ی mirrored در WSL.** WSL همان IPهای ویندوز را می‌گیرد. در فایل `%UserProfile%\.wslconfig` ویندوز:

<div dir="ltr">

```ini
[wsl2]
networkingMode=mirrored
```

</div>

بعد در PowerShell دستور `wsl --shutdown` را بزنید و WSL را دوباره باز کنید. کانتینرها خودشان بالا می‌آیند. آدرسی که در `offline.yml` می‌نویسید IP ویندوز روی شبکه‌ی نودها است (اینجا `192.168.120.1`). اگر لازم شد، در فایروال ویندوز پورت‌های 5000 و 8080 تا 8082 را باز کنید.

**راه ۲: port forwarding ویندوز** (PowerShell با دسترسی Admin). دقت کنید که IP داخلی WSL بعد از هر ری‌استارت عوض می‌شود و این دستورها باید دوباره اجرا شوند:

<div dir="ltr">

```powershell
$wsl = (wsl hostname -I).Split(" ")[0]
foreach ($p in 5000,8080,8081,8082) {
  netsh interface portproxy add v4tov4 listenaddress=0.0.0.0 listenport=$p connectaddress=$wsl connectport=$p
}
New-NetFirewallRule -DisplayName "kubespray offline repos" -Direction Inbound -Protocol TCP -LocalPort 5000,8080-8082 -Action Allow
```

</div>

اگر این ماشین یک سرور یا VM معمولی لینوکس است، این بخش لازم نیست و از IP خود ماشین استفاده کنید.

---

## ۲. آماده‌سازی (اینجا، با اینترنت)

در webui، تب **Offline Install**، برای inventory مورد نظر، مرحله‌ها را به ترتیب **▶ Run** کنید:

| مرحله | کار |
|---|---|
| Generate file & image lists | لیست فایل‌ها و imageها، از منبع‌های اصلی |
| Download static files | دانلود فایل‌ها به مخزن 8080 |
| Container images | دانلود imageها و ریختن آن‌ها در رجیستری 5000. اگر `register` وسط کار بایستد، باقی‌مانده با skopeo پر می‌شود. فقط وقتی همه‌ی imageها در رجیستری باشند موفق تمام می‌شود |
| OS packages | پکیج‌های اوبونتو (نسخه‌ی نودها، پیش‌فرض 24.04) با **همه‌ی** وابستگی‌ها |
| Python packages | پکیج‌های pip |
| Cilium for the Cilium tab | helm، cilium-cli، chart و همه‌ی imageهای Cilium (با digest اصلی). برای هر نسخه‌ای از Cilium که می‌خواهید آنجا نصب کنید، یک بار اجرا کنید |

بعد کارت **Ready for an isolated site?** ← **🔍 Check readiness**. همه‌ی ردیف‌ها باید ✅ باشند، **به‌جز** «offline.yml points at this host». آن ردیف را در محیط جدید و با IP جدید می‌نویسید.

بعد ماشین را خاموش کنید.

---

## ۲-ب. انتقال همه‌چیز به یک سرور دیگر (اختیاری)

اگر به‌جای جابه‌جا کردن خود این ماشین، می‌خواهید همه‌چیز روی **یک سرور دیگر** برود: webui، پروژه‌ی kubespray با همه‌ی دانلودها، imageهای docker، و داده‌ی رجیستری. بعد آنجا با `docker compose up` بالا می‌آید.

**پیش‌نیاز روی سرور مقصد:** Docker و compose plugin نصب باشند و کاربر عضو گروه `docker` باشد:

<div dir="ltr">

```bash
sudo usermod -aG docker devops    # then log out and back in
```

</div>

اسکریپت Docker را **نصب نمی‌کند**. فقط چک می‌کند و اگر نبود با پیام واضح متوقف می‌شود.

**از ترمینال**، روی همین ماشین:

<div dir="ltr">

```bash
cd ~/infra/kubespray-webui
# only checks (Docker, compose, disk space, ports) - copies nothing
./scripts/transfer.sh --host 192.168.12.22 --user devops --password '<password>' \
                      --dest /home/devops/kube-offline --check-only
# the real transfer
./scripts/transfer.sh --host 192.168.12.22 --user devops --password '<password>' \
                      --dest /home/devops/kube-offline
```

</div>

**از webui:** تب Offline Install ← کارت **Move everything to another server**: آدرس، کاربر، رمز و مسیر را وارد کنید ← **🔍 Check only** و بعد **🚚 Transfer**.

**کار اسکریپت، به ترتیب:**
1. چک‌ها: Docker و compose روی مقصد، **فضای دیسک** (هم مسیر مقصد و هم پوشه‌ی داده‌ی Docker)، و آزاد بودن پورت‌ها
2. کپی فایل‌ها با rsync. حدود ۵ گیگ نسخه‌ی تکراری کپی نمی‌شود
3. نوشتن `.env` با مسیرهای سرور جدید
4. ارسال imageهای docker
5. ارسال داده‌ی رجیستری، و بعد چک می‌کند حجمش دقیقاً برابر رسیده باشد
6. `docker compose up -d` و چک سلامت

**نکته‌ها:**
- **حجم:** حدود ۱۰ گیگ (فایل‌ها ۱.۹ گیگ، رجیستری ۶.۵ گیگ، imageها حدود ۲ گیگ).
- **اجرای دوباره امن است:** هر چیزی که سالم رسیده باشد رد می‌شود. اجرای دوم چند ثانیه طول می‌کشد.
- **گزینه‌های دیگر:**
  - `--key` به‌جای رمز
  - `--port`
  - `--with-backups` برای کپی بکاپ‌های etcd در RustFS
  - `--no-start`
  - رمز را می‌توانید به‌جای خط فرمان در `TRANSFER_PASSWORD` بگذارید
- **بعد از انتقال**، در webui سرور جدید (`http://<server>:8420`): کارت «Point kubespray at these repos» را با آدرس همان سرور بزنید، بعد Check readiness.

---

## ۳. در محیط ایزوله

۱. ماشین را روشن کنید. در پوشه‌ی `kubespray-webui` دستور `docker-compose up -d` را بزنید. هیچ چیزی دانلود یا build نمی‌شود.
۲. اگر WSL است، بخش ۱ را برای شبکه‌ی جدید چک کنید.
۳. **Offline Install** ← کارت **Point kubespray at these repos**: آدرس این ماشین را **همان‌طور که نودها می‌بینند** وارد کنید و **Write to offline.yml** را بزنید. با همین یک کلیک این‌ها با IP جدید نوشته می‌شوند:
   - `registry_host` و `files_repo` و `ubuntu_repo`
   - هر ۲۰ `*_download_url` (kubeadm، kubelet، containerd، …)
   - mirrorهای containerd برای `docker.io`، `quay.io`، `registry.k8s.io`، `ghcr.io`، `gcr.io` ← رجیستری 5000
۴. **Check readiness** باید حالا همه سبز باشد.
۵. تب **Installation**:
   1. **🔌 Check connectivity**
   2. **📦 Point node apt at offline repo**: apt همه‌ی نودها به مخزن 8081 وصل می‌شود. sourceهای خود نودها به `/etc/apt/offline-backup/` منتقل می‌شوند و پاک نمی‌شوند.
   3. **▶ Run cluster install**
   4. **✅ Verify cluster**
۶. تب **Cilium (Helm)**: دکمه‌ی بارگذاری نسخه‌ها در حالت آفلاین، فقط نسخه‌هایی را نشان می‌دهد که در مخزن هستند. نصب از chart محلی انجام می‌شود و imageها از رجیستری محلی می‌آیند.
۷. اگر روزی نودها دوباره به اینترنت وصل شدند: **↩ Restore node apt sources**.

---

## خطاهای رایج

| علامت | علت | راه حل |
|---|---|---|
| `dial tcp <ip>:5000: i/o timeout` روی نودها | نودها به این ماشین نمی‌رسند (مثلاً IP داخلی WSL) | بخش ۱ |
| `host will try HTTPS first ...` در لاگ containerd | پیام اطلاعاتی است (kubespray همیشه `skip_verify` را می‌نویسد). containerd بعد از شکست HTTPS سراغ HTTP می‌رود | اگر بعدش `i/o timeout` آمده، مشکل شبکه است (بخش ۱) |
| Container images: `does not provide any platform` | image چندمعماری که `docker push` نمی‌تواند push کند | خودکار با skopeo پر می‌شود. آخر لاگ باید `48/48 images present` باشد |
| تب Cilium: `no Cilium chart is in the files mirror` | مرحله‌ی Cilium اجرا نشده | Offline Install ← «Cilium for the Cilium tab» |
| apt روی نود: `Unable to locate package` | نسخه‌ی اوبونتوی نودها با پکیج‌های دانلودشده یکی نیست | مرحله‌ی OS packages را با نسخه‌ی درست اجرا کنید |
| `cilium connectivity test` تست‌های «world» را رد می‌کند | این تست‌ها اینترنت می‌خواهند | در محیط ایزوله طبیعی است |
| transfer: `Docker is not installed on ...` | Docker روی سرور مقصد نیست، یا کاربر عضو گروه docker نیست | Docker و compose plugin را نصب کنید، بعد `sudo usermod -aG docker <user>`، یک بار خروج و ورود، و اجرای دوباره |
| transfer: `not enough space ...` | دیسک مقصد کم است. پیغام دقیقاً می‌گوید کجا و چقدر | فضا آزاد کنید، یا مسیر یا دیسک دیگری بدهید |
| transfer: `ports already in use` | روی مقصد سرویس دیگری روی 5000 یا 8080 و بقیه است | آن سرویس را جابه‌جا کنید |

</div>
