# MinerU 旁路实验（未进入产品）

## 边界

本分支只建立与自托管 `mineru-api` 的薄客户端和单测，不改变 HalfHalf 的默认导入、
不在应用 Docker 镜像中安装 MinerU/模型，也不将 MinerU Markdown 直接送入排版。

## 运行方式

在独立机器或容器启动 MinerU：

```bash
mineru-api --host 127.0.0.1 --port 8000
```

HalfHalf 服务端仅在部署者配置下创建客户端：

```bash
HALFHALF_MINERU_API_URL=http://127.0.0.1:8000
```

接口依照 MinerU 3.x：`GET /health`、`POST /tasks`、`GET /tasks/{task_id}`、
`GET /tasks/{task_id}/result`。上传使用 multipart `files` 与 `return_md=true`。
本地 8GB 显存实验环境只下载 `pipeline` 模型，客户端会显式提交
`backend=pipeline`、`parse_method=auto` 和 `lang_list=ch`，不触发未部署的 VLM。

## 下一道门槛

用授权的文字 PDF、扫描 PDF、公式密集 PDF、表格/双栏 PDF、DOCX 做对照：

1. 现有 main 原生导入/视觉保真；
2. MinerU 输出；
3. 人工核对可编辑性、公式/表格误差、阅读顺序、耗时与内存。

只有在每一条结果仍保有来源页证据、公式经预检、低置信空间块保留原图，且资源成本
可接受时，才另立任务把结果接入异步导入队列。
