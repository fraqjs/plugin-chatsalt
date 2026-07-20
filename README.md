# fraq-plugin-chatsalt

通用 AI 对话插件。

## 安装与配置

将插件添加到 `fraq.yml` 的 `plugins` 字段下：

```yaml
plugins:
  # 本插件依赖 fraqjs/ai 和 fraqjs/kysely 插件，因此需要一并安装
  fraqjs/ai:
    # 在这里传入 AiPlugin 的配置选项
  fraqjs/kysely:
    # 在这里传入 KyselyPlugin 的配置选项
  # 推荐配合 fraqjs/message-store 插件使用，以便在数据库中持久化消息，减少远程拉取消息上下文的次数
  fraqjs/message-store:
    # 在这里传入 MessageStorePlugin 的配置选项
  chatsalt:
    # 角色设定文本，推荐使用 Markdown 格式。角色设定文本会在每次对话开始时被注入到上下文中。
    persona: |
      你是一个 AI 助手，专注于帮助用户解决问题。
      你应该始终保持礼貌和专业，提供准确和有用的信息。
    # 用于对话的语言模型，可以指定在 fraqjs/ai 插件中配置的模型名称或别名
    # 默认使用 ctx.ai.model() 获取的模型
    # chatModel: google/gemini-3.5-flash
    # 用于图像识别的语言模型，可以指定在 fraqjs/ai 插件中配置的模型名称或别名
    # 默认使用 chatModel 中指定的模型，如果未指定，则使用 ctx.ai.model() 获取的模型
    # visionModel: openai/gpt-5.6-luna
    # 上下文窗口大小，即提供给大模型的消息总数，默认值为 20
    contextWindow: 20
    # 若上下文中包含合并转发消息，则最多展开的层数，默认值为 0，即不展开
    maxForwardDepth: 0
    # 用于对话的温度参数，默认值为 0.7
    temperature: 0.7
    # 在调用工具时，最多允许的步骤数，默认值为 10
    maxToolSteps: 10
    # 有关记忆的配置项
    memory:
      # 是否启用记忆功能，默认值为 true
      enabled: true
      # 记忆窗口大小，即在对话中最多注入的记忆条数，默认值为 20
      maxWindow: 20
      # 对于每个对话场景，最多允许的记忆条数，默认值为 50
      maxScopeCount: 50
```
