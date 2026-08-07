# fraq-plugin-chatsalt

通用 AI 对话插件

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
  # 可选。安装后 chatsalt 会自动注册 WebUI；未安装时不影响对话功能
  fraqjs/webui-gateway:
    accessToken: ${{ env:FRAQ_WEBUI_TOKEN }}
  chatsalt:
    # 角色设定文本，推荐使用 Markdown 格式，并且保存在另一个文件中以保持配置文件可读性。
    # 这里的配置表示从 persona.md 文件中读取角色设定文本
    # 角色设定文本会在每次对话开始时被注入到上下文中。
    persona: ${{ text:persona.md }}
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
    # 有关触发对话的配置项
    trigger:
      # 触发对话的关键词列表，若消息中包含这些关键词，则会触发对话
      keywords:
        # - salt
        # - 机器人
    # 有关记忆的配置项
    memory:
      # 是否启用记忆功能，默认值为 true
      enabled: true
      # 记忆窗口大小，即在对话中最多注入的记忆条数，默认值为 20
      maxWindow: 20
      # 对于每个对话场景，最多允许的记忆条数，默认值为 50
      maxScopeCount: 50
    # 有关外部网页搜索工具的配置项
    externalWebSearch:
      # 是否启用外部网页搜索工具，默认值为 false
      enabled: false
      # 若启用，使用的语言模型，默认值为 chatModel 中指定的模型，如果未指定，则使用 ctx.ai.model() 获取的模型
      # 模型必须使用 `@ai-sdk/openai`（即 Responses API）提供的模型，否则无法使用网页搜索工具
      model: openai/gpt-5.6-luna
    # 有关 GitHub 工具的配置项
    github:
      # 是否启用 GitHub 工具，默认值为 false
      enabled: false
      # 若启用，必须提供 GitHub 访问令牌（token），用于访问 GitHub API
      token: ${{ env:GITHUB_TOKEN }}
    # 有关 WebUI 的配置项
    webui:
      # 是否注册 WebUI，默认值为 true
      enabled: true
      # 内存中最多保留的对话记录数，默认值为 100
      conversationLimit: 100
      # 内存中最多保留的警告记录数，默认值为 100
      warningLimit: 100
      # WebUI 最多查询的记忆条数，默认值为 500
      memoryLimit: 500
```

安装并配置 `fraqjs/webui-gateway` 后，可通过 `/webui/chatsalt/` 查看对话、警告和记忆记录。WebUI 由
Gateway 统一鉴权；如果未安装 Gateway，Chatsalt 不会注册任何 WebUI 路由。

## 编写人设

角色设定文本是指为大模型提供的角色设定信息，通常包括但不限于以下内容：

- 身份：姓名、年龄、性别、职业等基本信息
- 性格：是否开朗/内向、是否善于表达、是否有幽默感等
- 语言风格：口头禅、口癖、常用词汇等，可以包含例句
- 背景故事：家庭、成长经历、教育背景、人际关系、兴趣爱好等
- 知识边界：对于什么样的话题应该回答/给出模糊回答/拒绝回答等
- 互动目标：在角色视角看来，用户的身份、场景、目的等

一个好的角色设定文本可以让大模型更好地生成更符合预期的回答。仓库中包含一个[示例角色设定文本](./test/salt.persona.md)，可以作为参考。

## 开始对话

通过在消息中 `@` 机器人、回复机器人的消息或使用触发关键词来开始对话。机器人会根据角色设定文本和上下文信息生成回答。例如，对于上面的示例角色设定文本中的角色【纱露朵】，一个可能的对话是这样的：

```
用户: @纱露朵 你好呀~
纱露朵: 你好呀，我是纱露朵，请多关照的说喵~
```

## 使用 `chatsalt` 命令

`chatsalt` 可以提供一些除对话之外的功能，目前有如下用法：

- `chatsalt inspect`：查看插件的版本、对话模型和视觉模型等信息。
