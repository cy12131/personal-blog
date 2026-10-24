---
title: "FastStore：从零构建 C++ Linux 高并发文件服务器的完整实践"
description: "记录 FastStore 从 Reactor、Connection 状态机、Streaming PUT/GET、线程池边界，到部署、测试和 Benchmark 的完整工程实践与学习总结。"
pubDate: 2026-10-24
slug: "faststore-project-review"
category: "项目实践"
tags:
  - C++
  - Linux
  - epoll
  - Reactor
  - HTTP
  - ThreadPool
  - FastStore
draft: false
---

## 项目目标

FastStore 不是云存储产品，也不是调度算法研究。它是一条刻意收窄范围的工程训练路线：从一个能监听端口的 Linux 进程出发，依次走过需求、架构、编码、测试、Benchmark、客户端联调、配置、systemd 部署、故障恢复，最后形成 Git v1.0.0。

做这个项目之前，socket、epoll、线程池和文件 I/O 很容易以一组彼此分散的 API 出现。真正把它们放进同一个服务端程序后，问题变成了：一个请求如何跨过 TCP、解析器、文件系统和响应发送；非阻塞操作没有一次完成时，下一次事件应该从哪里继续；线程加入 Reactor 后，Connection 的状态究竟归谁修改；程序离开源码目录后，又怎样成为一个可配置、可观察、能够被服务管理器重新拉起的进程。

FastStore v1.0.0 最终提供文件列表、下载、元数据查询、上传和删除五个 HTTP 接口，支持最大 1 GiB 的 PUT、流式传输、固定线程池、环境变量配置、systemd 部署和 journald 日志，并通过独立的 Windows Qt Client 做真实联调。项目的价值不在接口数量，而在于把一条服务端工程链走完整，同时给每个状态、资源和失败路径找到明确的归属。

这五个接口的范围也有意保持简单：`GET /files` 返回按文件名排序的 JSON 列表，`GET /files/{name}` 流式下载普通文件，`HEAD /files/{name}` 只查询大小，`PUT /files/{name}` 流式上传，`DELETE /files/{name}` 删除文件。把范围控制在这些动作内，才有空间把空文件、错误状态、断连清理、并发访问和部署后的持久化真正做完，而不是不断增加表面功能。

项目采用 HTTP/1.1 的单连接单请求模型，响应使用 `Connection: close`。这不是通用 HTTP Server 的完整形态，却让第一版能够集中处理 TCP 字节流、请求边界、文件一致性和资源生命周期。学习项目的范围一旦不受控制，很容易得到许多只完成正常路径的功能；FastStore 更看重的是每一条已选择路径都能被测试和解释。

## 最终架构：一个请求到底怎么走

先看最终架构。它不是一开始就完整出现的，而是在解析、Streaming、并发和部署需求逐步加入后形成的：

![整体请求架构](/images/faststore/architecture.svg)

`Server` 持有 listener、epoll、eventfd、Connection map 和 ThreadPool，并运行 Reactor。`Connection` 集中保存一个 TCP 连接的解析、上传、下载和发送进度。`HttpParser` 只解析 request line 与 headers，不保存 body。`Router` 把 method 和 target 映射到业务操作，`FileService` 则把文件名验证、directory fd 和 POSIX 文件操作隔离在网络层之外。

普通请求的完整路径是：Reactor 从 socket 读取字节，Connection 增量解析 header；非 PUT 请求准备好后，复制 `HttpRequest` 交给 Worker。Worker 同步执行 Router 与 FileService，产生 `RouteResult`，再封装成 `RouteCompletion` 放入完成队列并用 eventfd 唤醒 Reactor。Reactor 校验结果属于当前连接后，把它应用回 Connection，最后继续发送响应。

PUT 是一个重要例外。它的 body 必须伴随 `recv` 持续消费，所以临时文件写入和最终 commit 留在 Reactor。GET 则由 Worker 打开文件并确定长度，但文件 chunk 的读取、socket partial send 和 EPOLLOUT 续传仍由 Reactor 完成。这条边界让 Worker 可以承担同步路由工作，却不夺走 socket 和可变 Connection 状态的所有权。

这里的对象分工并不是为了增加抽象层次。Server 回答“哪些事件现在可以推进”，Connection 回答“这条连接已经做到哪一步”，Parser 回答“现有字节能否形成合法请求元数据”，Router 回答“协议动作对应什么文件操作”，FileService 回答“如何在受限目录内安全执行”。当错误发生时，也能沿着同一条链判断应由谁生成响应、谁关闭资源、谁决定连接结束。

最终架构还包含两个相反方向的控制流。请求数据从 socket 向 Parser 或上传文件前进；Worker 的结果则通过普通 C++ 队列和 eventfd 回到 Reactor。前者处理网络输入的不完整性，后者处理异步结果与连接生命周期可能错位的问题。把两条路径画在一起后，线程池不再只是“把任务丢到后台”，而是架构中的一次明确所有权交接。

## Reactor 与 Connection：非阻塞服务器真正难在哪

TCP 只提供有序字节流，不提供 HTTP 消息边界。一次 `recv` 可能只得到半行 request line，也可能同时得到完整 header 和一部分 PUT body。因此，“一次可读事件等于一个请求”从一开始就是错误模型。

在 LT 模式下，listener 和 client socket 都应当一次处理到 `EAGAIN`。对 `recv` 来说，正数表示取得一段字节；0 表示 peer 已关闭写方向；`EINTR` 需要重试；`EAGAIN` 或 `EWOULDBLOCK` 只表示这一轮暂时没有更多数据，应返回事件循环；其他负值才是真正的传输错误。核心读取循环保持这种区分：

```cpp
const ssize_t n = ::recv(client_fd_, buffer.data(), buffer.size(), 0);
if (n > 0) {
    appendInput(buffer.data(), static_cast<std::size_t>(n));
    if (!processBufferedInput(file_service)) {
        return ReadStatus::kError;
    }
    continue;
}
if (n == 0) return handlePeerClosed();
if (errno == EINTR) continue;
if (errno == EAGAIN || errno == EWOULDBLOCK) return ReadStatus::kOpen;
return ReadStatus::kError;
```

Connection 保存 `input_buffer_`、`read_offset_`、增量 parser 和当前状态。新字节先追加进 buffer，parser 只观察未消费区域；headers 完整后，用精确的 consumed bytes 推进偏移，剩余字节继续留给 PUT body。已消费区域达到阈值后才 compact，避免频繁搬移 vector。socket 每次读取 16 KiB，header section 上限 32 KiB，因此上传文件变大不会让整个 body 驻留在输入缓冲区。

Parser 本身只产出 method、target、version、headers 和 `content_length`，不拥有 body。它区分 `kIncomplete`、`kHeadersComplete` 和 `kError`：找不到完整 CRLF 或 header 终止符时等待更多字节；header 完整后生成请求元数据；格式或边界不合法时停止解析。这种设计让 parser 不需要知道文件如何写入，也让 Connection 能根据 method 决定后续状态。

解析规则被刻意收紧：只接受 HTTP/1.1，Host 不能为空，重复 header 与 `Transfer-Encoding` 会被拒绝；PUT 必须提供 Content-Length，其他已支持 method 不能声明非零 body。request line 上限 8 KiB，header section 上限 32 KiB，header 数量上限 100。Content-Length 需要完整十进制解析并检查溢出。规则收紧减少了协议歧义，也让每个失败分支更容易测试。

状态机回答的是“下一次事件到来时做什么”，而不是为代码贴标签：

![Connection 状态机](/images/faststore/connection-state.svg)

这也是项目对 non-blocking I/O 最直接的认识：关键不只是“不阻塞”，而是当前工作没有做完时，必须保存足够的执行进度，让下一次事件能从正确位置继续。状态、buffer 和 offset 缺一不可。

epoll LT 也没有免除“处理到暂时无法继续”的责任。只要条件仍满足，LT 还会再次报告事件，但如果每次只读一点就提前返回，事件循环会反复唤醒并积压可立即完成的工作。listener 的 accept 与 client 的 recv 都循环到 `EAGAIN`，然后才把控制权还给 Reactor。`EAGAIN` 在这里不是请求结束，而是一次清楚的暂停点。

同样，EPOLLOUT 不应永久注册。大多数 socket 大部分时间都处于可写状态，持续监听会带来大量没有业务意义的通知。Server 根据 Connection 的 `wantsRead()` 与 `wantsWrite()` 动态更新 interest：等待 Worker 时不需要 socket 读写事件，准备发送时才打开 EPOLLOUT，响应完成后关闭连接。这使 epoll interest 与状态机保持一致。

## Streaming PUT / GET：大文件传输本质上是状态管理

如果 PUT 先把完整文件读进 vector，再一次写入磁盘，内存会随文件大小线性增长，而且仍然无法绕过 TCP 分片。FastStore 在 header 完整后验证 `Content-Length`，创建临时文件，然后把已收到的 body chunk 逐段写入。收到的字节达到预期长度、且没有多余 buffered bytes 后，才在同一目录内 rename 为最终文件并返回 201。

上传先落到 `.faststore-upload-<random>` 临时文件。未完成时断连或发生异常，`UploadFile` 的析构会关闭 fd 并删除临时目录项，因此用户不会看到半成品。最大 PUT 是 1 GiB，也就是协议允许的 `Content-Length` 上限；它不是内存 buffer 大小，更不代表自动测试真的上传了 1 GiB。

完整 body 到达后，上传先关闭临时文件，再在同一数据目录内切换目录入口。首次创建使用 `renameat2(..., RENAME_NOREPLACE)` 区分新文件和覆盖；目标已存在时，还会先用 `fstatat(..., AT_SYMLINK_NOFOLLOW)` 确认它是普通文件，再使用 `renameat` 替换。源实现也保留了一个诚实的边界：检查与替换之间仍可能存在目录竞争窗口，要彻底消除需要独占目录写权限或更复杂的事务协调。

Content-Length 也是上传状态机的不变量。Connection 记录预期和已接收字节数；如果已经读到的数据超过声明长度，就返回 400，并在 commit 前放弃上传。v1.0.0 在完整 body 提交、发送响应后关闭连接，不把额外字节解释为同一连接上的第二个请求。这与不支持 pipelining 的范围保持一致。

GET 的方向相反。Worker 打开文件并固定 Content-Length，Reactor 先发送 response header，再以 64 KiB chunk 读取文件。一次 `send` 返回的正数可能小于请求长度，所以 `response_offset_`、`file_chunk_send_offset_` 和 `sent_file_bytes_` 都必须持续推进。遇到 `EAGAIN` 时保留当前 chunk 和 offset，等待 EPOLLOUT 后续传：

```cpp
const ssize_t sent = ::send(
    client_fd_, file_buffer_.data() + file_chunk_send_offset_,
    file_chunk_valid_size_ - file_chunk_send_offset_, MSG_NOSIGNAL);
if (sent > 0) {
    file_chunk_send_offset_ += static_cast<std::size_t>(sent);
    sent_file_bytes_ += static_cast<std::uint64_t>(sent);
    continue;
}
if (sent == -1 && (errno == EAGAIN || errno == EWOULDBLOCK)) {
    return WriteStatus::kPending;
}
```

两条路径可以压缩成一张图：

![Streaming PUT 与 GET 流程](/images/faststore/streaming-io.svg)

这里最容易混淆的是两个数字：1 GiB 是最大 PUT 的协议限制，64 KiB 是 Streaming GET 的固定工作块。真正维持内存边界的是“当前 chunk 没发完就不加载下一个”。客户端读取变慢、socket send buffer 填满后，`send` 返回 `EAGAIN`，文件读取也随之暂停；这就是单连接发送路径上的 backpressure。它不等于全局流量治理——ThreadPool task queue 仍然没有容量上限，也没有全局带宽或连接配额。

GET 还需要处理文件在传输期间发生变化。Worker 打开文件时得到固定 size，Connection 以它作为 Content-Length 和 `expected_file_bytes_`。外部进程随后追加内容，Server 不会越过最初确定的长度；如果文件被截短并提前 EOF，传输进入错误并关闭连接。它没有提供文件快照语义，但至少不会静默发送与响应头不一致的字节数。

因此 Streaming 并不是把普通读取放进循环这么简单。PUT 要保存已接收长度、临时文件与提交状态；GET 要保存响应头偏移、当前 chunk 的有效长度与发送偏移，以及加载和发送的累计字节。真正保存的不是“大文件数据本身”，而是每个有限工作块的执行进度。

## 加入 ThreadPool 后，我才真正理解“线程安全”不是加锁

最直觉的线程池接法，是让 Worker 捕获 `Connection&`，在后台直接 route、send 或修改状态。但 Reactor 可能因为断连或 EPOLLERR 销毁 Connection；即使对象仍在，两个线程同时修改 state 和 buffer 也会形成数据竞争。给 Connection 加一把大锁并不能自动给这些生命周期关系一个清楚答案。

FastStore 最终确定了一条边界：**Reactor owns mutable Connection state**。派发前，Connection 从 `kRequestReady` 进入 `kWaitingForWorker`，并复制出独立的请求；Worker 只接收 request、client fd 和 connection_id，只输出结果：

```cpp
std::optional<HttpRequest> Connection::beginWorkerDispatch() {
    if (state_ != State::kRequestReady || http_parser_.request() == nullptr) {
        return std::nullopt;
    }
    state_ = State::kWaitingForWorker;
    return *http_parser_.request();
}

struct RouteCompletion {
    int client_fd;
    std::uint64_t connection_id;
    RouteResult result;
};
```

ThreadPool 本身是固定 worker 数量的实现：task 在锁内入队，Worker 用带 predicate 的 condition variable 等待，取出任务后先释放 mutex 再执行；shutdown 设置 stopping、唤醒全部线程、排空已入队任务并逐个 join。它没有动态扩缩、priority 或 work stealing，因为项目在这里要解决的是线程生命周期和 Reactor 边界，而不是继续扩展调度策略。

condition variable 的 predicate 同时观察 `stopping_` 和任务队列，避免虚假唤醒破坏退出条件。停止后也不是立即抛弃任务，而是在 `stopping_ && tasks_.empty()` 时退出。单个 task 的异常由 Worker 内部捕获，避免异常越过 thread entry 触发整个进程终止。这些行为看起来不如“动态扩容”显眼，却直接决定 shutdown、异常和析构路径是否可靠。

Worker 在锁外执行任务同样重要。如果持有 queue mutex 运行 Router 或文件操作，一个慢任务会同时阻止新任务 submit 和其他 Worker 取任务。锁真正保护的是 queue 与 stopping 之间的一致顺序，而不是笼统地“保护整个线程池”。这也是我从项目里重新理解线程安全的地方：先决定共享状态和 owner，再决定锁覆盖哪个最小一致性边界。

Worker 完成同步工作后，还有两个不同问题：结果放在哪里，以及怎样让睡在 `epoll_wait` 的 Reactor 知道结果已经到达。completion queue 是数据通道，eventfd 是通知通道，两者不能互相替代：

![Worker completion queue 与 eventfd](/images/faststore/worker-completion.svg)

只有 fd 也不够。连接 A 使用 fd 12，关闭后，连接 B 可能再次得到 fd 12；如果 A 的旧 completion 此时才返回，只比较 fd 就可能污染 B。Server 因此在 accept 时分配单调递增的 `connection_id`。Reactor 应用结果前同时检查 fd 仍存在、connection_id 一致、Connection 仍在 `kWaitingForWorker`，否则把它视为 stale completion 丢弃。这个设计处理的是“异步结果可能晚于连接生命周期”这一事实。

测试专门制造较大的 list 工作量、主动断开并进行 fd churn，用来验证旧 completion 不会落到新连接上。这个场景说明，数据竞争只是并发正确性的一部分；即使所有共享容器都有 mutex，异步结果的身份仍可能已经过期。`fd + connection_id + state` 三重校验把“这是不是原来的连接”变成了可执行的不变量。

## RAII、FileService 与资源所有权

网络错误、客户端断连和 Worker 异常会让清理路径迅速增多。如果资源没有唯一 owner，每个 return 分支都可能遗忘一个 fd 或临时文件。FastStore 的规则很简单：谁拥有，谁释放。

`Server` 拥有 listener、epoll、eventfd、Connection map 和 ThreadPool；`Connection` 拥有 client fd 及上传、下载状态；`FileService` 拥有 data directory fd；`ReadFile` 拥有下载文件 fd；`UploadFile` 拥有临时文件 fd、复制的 directory fd 和临时目录项；`ThreadPool` 拥有 worker threads、任务队列和同步原语。这些类型删除 copy、实现 move，避免两个对象同时认为自己拥有同一资源。

RAII 在这里不只是“析构函数自动 close”。Server 销毁时要先让 ThreadPool shutdown 并 join，保证不再有 Worker 使用 FileService、completion queue 或 eventfd；然后销毁 Connections，最后关闭 Server 自己的 fd。成员生命周期顺序必须符合跨线程依赖，资源所有权才真正可推理。

FileService 进一步固定了文件系统边界。它初始化时打开 data directory，后续使用 `openat`、`fstatat`、`unlinkat` 和 `renameat` 相对这个 directory fd 操作。配合 `O_NOFOLLOW`、`AT_SYMLINK_NOFOLLOW` 和严格的 basename 验证，symlink、目录、FIFO、路径穿越以及内部临时文件名称都不会被当作普通用户文件。重点不是 API 写法，而是所有文件访问都被约束在一个已打开的目录对象下。

文件名验证拒绝空字符串、超过 255 bytes 的名字、`.`、`..`、任何包含 `..` 的名字、斜杠、反斜杠、NUL，以及 `.faststore-upload-` 前缀。它不做 URL decoding，也因此没有试图覆盖所有合法文件名。像 `report..txt` 也会被拒绝，这是用更严格但一致的规则换取更容易证明的边界。

目录枚举还有一个容易遗漏的并发细节：普通 `dup` 会共享 open file description，也就共享目录 offset。`listFiles` 通过 `openat(directory_fd_, ".", ...)` 创建独立 description，再交给 `fdopendir` 和 `readdir`，避免多个 Worker 同时列目录时互相推进读取位置。最终只返回验证通过的普通文件，并按文件名排序。

Router 因此不需要知道这些 POSIX 细节。它只把 FileError 映射为相应 HTTP 状态，把 GET 包装成同时携带响应和 move-only `ReadFile` 的结果，把 HEAD 转换为只有 Content-Length 的响应。网络层、协议层和文件系统层的错误语义得以分开。

## 从能运行到能部署：Config、systemd、测试和 Benchmark

本地能运行并不等于能够交付。M8 把端口、数据目录、worker 数量和 quiet 模式集中到 `FASTSTORE_PORT`、`FASTSTORE_DATA_DIR`、`FASTSTORE_WORKERS`、`FASTSTORE_QUIET`。配置先经 `loadServerConfig()` 完整读取和验证，成功后 main 才创建目录、打开 FileService 和启动 Server。数字解析拒绝空值、部分解析、越界值和多余字符，让错误在启动阶段 fail fast，而不是悄悄退回默认配置。

```cpp
const auto result = std::from_chars(
    value.data(), value.data() + value.size(), parsed);
if (value.empty() || result.ec != std::errc{} ||
    result.ptr != value.data() + value.size() ||
    parsed < minimum || parsed > maximum) {
    throw std::invalid_argument("Invalid configuration value");
}
return parsed;
```

Server 内部不再随时调用 `getenv`，配置读取时机、默认值和测试边界因此集中在单一入口。`loadServerConfig()` 只读取与验证，不创建目录也不 bind socket；只有全部配置有效，main 才开始产生外部副作用。对 systemd 服务来说，这意味着错误端口、非法 worker 数量等问题能直接表现为启动失败，并被 journald 观察到。

部署时，源码树与 runtime 被明确分开：Release executable 安装到 `/opt/faststore/bin/faststore`，持久数据放在 `/var/lib/faststore/data`，unit 位于 `/etc/systemd/system/faststore.service`。进程以非 root 的 `faststore` user 运行，`Restart=on-failure` 配合两秒重启间隔，stdout/stderr 进入 journald。`FASTSTORE_QUIET=1` 只抑制高频 informational log，错误仍然保留，也避免 benchmark 被日志 I/O 主导。

安装脚本要求 root 执行，用 root 所有的 0755 权限安装二进制，用 `faststore:faststore` 的 0750 权限管理数据目录，并安装 unit 后执行 daemon-reload。脚本有意不自动 start、enable，也不删除已有数据，因为“安装文件”和“改变服务运行状态”是两种不同的管理动作。拆开以后，升级与运维行为更容易预测。

最终验收向进程发送 SIGKILL 后，systemd 记录异常退出，并在约两秒后以新 PID 拉起服务；持久目录中已经提交的文件仍可读取。这说明的是 systemd 监督和数据持久化有效，而不是应用实现了优雅恢复。管理员主动执行 `systemctl stop` 也不会被 `Restart=on-failure` 当作故障重新启动。

最终验证不是只看服务“启动成功”。Debug 与 Release 的 8 个测试目标均为 8/8 通过；系统级验收覆盖 CRUD、空文件、典型错误码、64 个并发 GET、主动断连、持久化和 SIGKILL recovery。大文件实验实际上传并下载 256 MiB，前后 SHA-256 都是 `a6d72ac7690f53be6ae46ba88506bd97302a093f7108472bd9efc3cefda06484`。它证明这一路径能在有界用户态 buffer 下保持端到端完整性，但不等于实测了完整 1 GiB。

八个测试目标覆盖 parser、FileService、streaming upload、HTTP response、streaming GET、robustness、ThreadPool 和 Config。协议层验证 1 GiB 的 Content-Length 可以接受、超过一个字节返回 413；真实数据路径选择 256 MiB，避免仅为验证常量消耗不必要的时间和磁盘。Qt Client 则从 Windows 端完成 list、upload、download 和 delete，迫使接口接受一个独立客户端实现，而不是只在 curl 的正常路径里成立。

c=16 的最终 Release 代表结果如下：

| Workload | req/s | Throughput | Mean | P99 | CPU | Peak RSS |
|---|---:|---:|---:|---:|---:|---:|
| HEAD | 10348.34 | - | 1.50 ms | 3.40 ms | 45.40% | 4616 KiB |
| GET 4 KiB | 12154.13 | 48.17 MiB/s | 1.19 ms | 2.336 ms | 95.20% | 5504 KiB |
| GET 8 MiB | 271.97 | 2181.12 MiB/s | 58.11 ms | 100.266 ms | 83.79% | 5816 KiB |
| PUT 64 KiB | 1915.33 | 不把响应流量当上传吞吐 | 12.84 ms | 118.868 ms | 35.57% | 5024 KiB |

相对旧 M6-B 的相同 c=16 数据，HEAD 约 +7.3%，GET 4 KiB 约 +10.0%，GET 8 MiB 约 +25.2%，PUT 64 KiB 约 -9.4%。但这一轮只有 2 秒 warmup、5 秒 measurement、1 repeat；旧正式基线则是 5 秒、20 秒、3 repeats。调度、page cache 和单次波动都会影响短测，因此谨慎结论只能是：当前版本没有出现明显整体性能回退，不能据此宣称确定性能提升。

## FastStore 最终让我学到了什么

FastStore 最后接通了两条链。第一条是请求执行链：

> Client → TCP → epoll → Connection → HttpParser → Worker / Router → FileService → response state → socket → Client

第二条是工程交付链：

> 代码 → 自动化测试 → Benchmark → Release → systemd Deployment → journald / failure recovery → Git v1.0.0

只看第一条，会得到一个本机能跑的程序；只看第二条，没有状态机和资源所有权，部署只会放大隐藏问题。真正需要掌握的不是背下每个系统调用，而是能回答：当前状态是什么，谁拥有这个资源，partial I/O 后从哪里继续，异步结果回来时对象还是不是原来的对象，失败后是否留下半成品，以及怎样用测试和日志证明行为符合预期。

项目也保留了清楚的限制：只支持 HTTP/1.1 和 `Connection: close`，不支持 keep-alive、pipelining、chunked transfer、Range、TLS 和认证；ThreadPool 固定大小且 task queue 无界；进程没有应用层的 graceful SIGTERM drain。systemd 在 SIGKILL 后重新拉起进程，也不等于应用实现了 graceful recovery。这些边界没有被包装成超出实际范围的能力，而是 v1.0.0 为了守住学习范围做出的选择。

如果重新推演这个项目，最先应该画出的不是类图，而是 PUT、GET 和普通响应各自的状态路径，再列出 listener、client fd、directory fd、temporary file 和 worker thread 的 owner。模块边界也应尽早固定：Parser 只产生元数据，FileService 只操作受限目录，Router 只完成协议到业务的映射，Reactor 保持 Connection 的可变状态。每加入一个状态，同时补上断连、`EAGAIN` 和清理路径的测试。

完成项目并不意味着可以不查文档地背出所有 socket flag、systemd 字段或 C++ API。更实际的能力标准是，能够先设计状态与 ownership，知道哪里必须查证，并用测试、日志和明确的不变量定位问题。例如 Worker 不修改 Connection、未完成 PUT 不出现最终文件、发送 offset 永不倒退、旧 completion 不应用到新连接。这些约束比记住函数签名更能迁移到下一个服务端项目。

回头看，epoll、Streaming、ThreadPool、RAII 和 systemd 并不是五组独立知识点。它们共同围绕状态、所有权、进度和失败恢复形成一套可以推理、验证和交付的工程过程。FastStore 真正留下的，也正是这种把一个请求从 socket 追到文件系统、再把一份代码追到实际服务的能力。

