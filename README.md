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

  # 可选，安装后 chatsalt 会自动注册 WebUI，未安装时不影响对话功能
  fraqjs/webui-gateway:
    # 在这里传入 WebuiGateway 的配置选项

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

    # 主人（管理员）列表，可用于执行部分命令，但不会将相关信息注入 prompt
    owners: [10001, 10002]
    # 上下文窗口大小，即提供给大模型的最少消息数，默认值为 20
    contextWindow: 20
    # 上下文窗口起点的移动步长，默认值为 10
    # 窗口起点每隔 contextStep 条消息才向后移动一次，期间的对话只在上下文末尾追加消息，便于命中模型提供商的提示词缓存；
    # 因此实际提供的消息数在 contextWindow 到 contextWindow + contextStep - 1 之间浮动（撤回等缺失的消息不计入）。
    # 设为 1 则每条新消息都会移动窗口起点，即固定提供 contextWindow 条消息，但几乎无法命中缓存
    contextStep: 10
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
    # 有关模型内置网页搜索工具的配置项
    # 启用前，请确认你使用的模型是否支持
    builtinWebSearch:
      # 是否启用模型内置网页搜索工具，默认值为 false
      # 目前仅支持如下 AI SDK 提供的模型：
      # - @ai-sdk/anthropic
      # - @ai-sdk/google
      # - @ai-sdk/openai
      # 此外，请确认你使用的模型是否支持网页搜索工具，否则启用后可能会导致模型无法正常工作
      enabled: false
    # 有关外部网页搜索工具的配置项
    externalWebSearch:
      # 是否启用外部网页搜索工具，默认值为 false
      enabled: false
      # 若启用，使用的语言模型，默认值为 chatModel 中指定的模型，如果未指定，则使用 ctx.ai.model() 获取的模型
      # 目前只支持上述三种模型提供的网页搜索工具
      model: openai/gpt-5.6-luna
    # 有关直接读取网页的配置项。启用后，模型可以读取上下文中明确提供的 HTTP 或 HTTPS URL
    # 支持 HTML、JSON、XML、Markdown、CSV 和纯文本；XML 只作为文本读取，不会解析外部实体
    webPage:
      # 是否启用网页读取工具，默认值为 false
      enabled: false
      # 单次请求超时时间，默认值为 10000 毫秒
      timeoutMs: 10000
      # 最大响应正文大小，默认值为 2 MiB
      maxResponseBytes: 2097152
      # 返回给模型的最大正文字符数，默认值为 20000
      maxContentLength: 20000
      # 最大重定向次数，默认值为 3；每次重定向都会重新校验目标地址
      maxRedirects: 3
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
      # 内存中最多保留的自动判断记录数，默认值为 300
      autoDecisionLimit: 300
    # 有关自动模式（实验性）的配置项，见下方「自动模式」一节
    auto:
      # 是否启用自动模式，默认值为 false
      enabled: false
      # 启用自动模式的群号白名单，必填
      groups: [123456789]
      # 影子模式：照常判断和生成回复，但不发送，只记录到 WebUI，默认值为 false
      shadow: true
      jev:
        # TypeSafe API Key，必填
        apiKey: ${{ env:TYPESAFE_API_KEY }}
        # TypeSafe API 地址，必须以 /v1 结尾，默认值为 https://api.typesafe.ai/v1
        # 可替换为兼容 System One 接口的代理或自建服务，请求会发送到 <baseURL>/systemone
        baseURL: https://api.typesafe.ai/v1
        # 使用的 Jev 模型，默认值为 jev-1.14.0。建议固定版本号而不是 jev-latest，避免模型更新后阈值失效
        model: jev-1.14.0
        # 单次请求超时，默认值为 5000 毫秒；超时或出错时视为不发言
        timeoutMs: 5000
      # 机器人的名字和别名，用于识别「没有 @ 但在叫机器人」的消息
      names: [纱露朵, 盐, bot, 机器人]
      # 机器人擅长的领域，必填。只有在这个范围内，机器人才会主动插话。
      # Jev 以英文训练为主，推荐用英文描述，可以夹带中文专有名词
      expertise: 'maimai DX (舞萌) rhythm game: charts, difficulty constants, rating, song unlocks, play technique.'
      # 不参与的话题，默认值为 [politics, history, romance or sexual content]
      avoidTopics: [politics, history, romance or sexual content]
      # 提供给 Jev 的上下文消息条数，默认值为 8
      stateMessages: 8
      # 群里安静多久后才做决定，默认值为 3000 毫秒
      debounceMs: 3000
      # 刷屏时最多等待多久后做决定，默认值为 10000 毫秒
      maxBurstWaitMs: 10000
      # 主动插话的配额（被叫到和接话不受限制）
      budget:
        # 每个群每小时最多主动插话次数，默认值为 3
        perHour: 3
        # 两次主动插话的最小间隔，默认值为 600000 毫秒（10 分钟）
        minIntervalMs: 600000
      # 有人嫌机器人烦时，自动模式在该群静音的时长，默认值为 21600000 毫秒（6 小时）
      muteOnComplaintMs: 21600000
      # 判断阈值，一般不需要修改，可在 WebUI「自动判断」页观察概率后调整
      thresholds:
        addressed: 0.75       # 判定「在叫机器人」的最低概率
        continuation: 0.7     # 判定「在接机器人的话」的最低概率
        topicFit: 2.3         # 主动插话要求的话题相关度（0-3）
        invitesInput: 0.7     # 主动插话要求的「确实在提问」概率
        privateExchange: 0.4  # 高于此值视为别人在私聊，不插话
        sensitive: 0.6        # 高于此值视为敏感话题，一律沉默
        wantsBotQuiet: 0.7    # 高于此值视为嫌机器人烦，触发静音
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

## 自动模式（实验性）

启用后，机器人会在白名单群里自己判断是否开口，不需要 @。判断由 TypeSafe 的决策模型 [Jev](https://docs.typesafe.ai/) 完成，它只返回概率，不生成文字，每条消息的判断成本极低。

机器人只会在三种情况下开口：

1. **被叫到**：没有 @，但叫了 `names` 中的名字并且在跟机器人说话。
2. **接话**：机器人刚说过话，有人没引用就接着说。
3. **主动插话**：最新一条消息是在认真提问，话题属于 `expertise`，并且不是别人之间的私聊。这种情况受 `budget` 配额限制。

此外：

- 群里刷屏时，机器人会等安静下来再判断，同一批消息最多回复一条。
- 敏感话题一律沉默。如果有人嫌机器人烦，自动模式会在该群静音一段时间。
- 对话模型仍可以输出 `no_reply` 放弃发言。在自动模式下，这不会产生警告。
- 自动模式下机器人不会给消息加表情回应。主动插话回复的是最新消息时，不会引用原消息。

建议先开启 `shadow: true` 运行一段时间，在 WebUI 的「自动判断」页查看每条消息的各项概率和最终决定，确认没问题后再关闭影子模式。也可以先用 `pnpm tsx test/jev-probe.ts`（需要设置 `TYPESAFE_API_KEY`）查看 Jev 对几条示例消息的判断。

> 自动模式会把白名单群中的消息发送给 TypeSafe 进行判断，请在启用前告知群成员。

## 使用 `chatsalt` 命令

`chatsalt` 可以提供一些除对话之外的功能，目前有如下用法：

- `chatsalt inspect`：查看插件的版本、对话模型和视觉模型等信息。
- `chatsalt rename <新名片>`：更改机器人在当前群的群名片。
