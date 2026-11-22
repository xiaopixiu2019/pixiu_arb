# Windows SSH 连接器

PIXIU ARB SSH 连接器让 Windows 用户通过本机浏览器访问自己服务器上的 PIXIU ARB。客户端只转发访问，任务由服务器后台运行。

## 一次配置

1. Windows 10/11（64 位）需要系统的 **OpenSSH 客户端**。缺少时可在「设置 → 可选功能」安装。
2. 从[连接器发行页](https://github.com/xiaopixiu2019/pixiu_arb/releases/tag/ssh-client-v1.0.0)获取 `Pixiu-ARB-SSH.exe` 和 `SHA256SUMS`。也可以按下文从源码构建。核对 EXE 的 SHA-256 再运行。
3. 第一次打开，填入**自己的**服务器 IPv4、SSH 用户名和端口，以及服务器网页端口。本地端口和服务器网页端口默认都是 `17840`。本地端口冲突时，填一个空闲端口。
4. 向服务器管理员取得并核验服务器的 **Ed25519 主机公钥**。通常是服务器上 `/etc/ssh/ssh_host_ed25519_key.pub` 那一行，格式以 `ssh-ed25519` 开头。填入连接器后，每次连接都用它核验同一台服务器。主机换钥匙时请先与管理员核对。
5. 连接器在这台电脑生成一对专用钥匙。点击「复制公钥」，把复制出的客户端公钥交给服务器管理员登记。每台电脑用自己的钥匙，私钥留在各自的 Windows 用户目录。服务器主机公钥和电脑的客户端公钥各有用途。
6. 公钥登记后点「重新连接」。程序会打开本地浏览器，并设置当前 Windows 用户登录时自动启动的守护任务。若 Windows 策略限制自启动，已经连通的页面仍可使用，下次双击 EXE 即可重连。

## 给服务器管理员

自托管服务可以按[部署说明](deployment.md)绑定服务器回环地址。对只需要网页的使用者，给独立 SSH 账号启用公钥认证、仅允许本地转发到精确的服务端口，同时禁止 Shell、SFTP 和反向转发。用服务实际端口替换示例的 `17840`，并按操作系统的 SSH 配置流程验证后加载。

```text
Match User pixiu-web
    AuthenticationMethods publickey
    AllowTcpForwarding local
    PermitOpen 127.0.0.1:17840
    PermitListen none
    AllowStreamLocalForwarding no
    MaxSessions 0
Match all
```

在该用户的 `authorized_keys` 中，每台电脑一行，可加 `restrict,port-forwarding,permitopen="127.0.0.1:17840"` 作为额外限制。核对 `sshd -t`，实测授权端口可访问，其他端口和终端会话均被拒绝。部署端口保持回环监听，由 SSH 提供远程访问。

## 连接方式和诊断

- 默认识别有 IPv4 地址的物理网卡，包括 Wi-Fi。选择**使用系统网络**后，SSH 由系统决定路径，可能经过当前 VPN 或 Clash。两种方式都验证同一个主机公钥。
- 登录后后台自动重连。日志在 `%LOCALAPPDATA%\PixiuArbPublicSsh\tunnel.log`。任务名称是 `PixiuArbPublicSsh`。
- 连接器为每个 Windows 用户保存一套连接配置。如需换服务器，先在任务计划程序禁用该任务并退出 Windows 会话，再删除同目录的 `server-profile`，重新打开 EXE。再次登记新服务器端的授权，并在核实后启用该任务。
- 关闭网页或关闭客户端所在电脑的网络，只中断浏览器访问。服务器上的任务依旧由服务器管理。在同一实例上的多个客户端共享任务和交易状态。

## 从源码构建

在 Windows PowerShell 中运行：

```powershell
.\tools\windows-ssh-client\build.ps1
```

产物与 `SHA256SUMS` 位于 `tools\windows-ssh-client\dist`。构建脚本会验证配置校验、回环转发、Wi-Fi 识别和登录任务定义。服务器端授权及真实连接需在使用者自己的设备上验收。
