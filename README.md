# fraq-plugin-chatsalt

通用 AI 对话插件。

## 安装与配置

将插件添加至 `dependencies`，然后在创建 `Context` 时引入并配置插件。本插件依赖 [`@fraqjs/plugin-ai`](https://fraq.dev/docs/plugins/ai) 和 [`@fraqjs/plugin-kysely`](https://fraq.dev/docs/plugins/kysely) 插件，因此需要一并安装。推荐配合 [`@fraqjs/plugin-message-store`](https://fraq.dev/docs/plugins/message-store) 插件使用，以便在数据库中持久化消息，减少远程拉取消息上下文的次数。

```typescript
import AiPlugin from "@fraqjs/plugin-ai";
import KyselyPlugin from "@fraqjs/plugin-kysely";
import ChatsaltPlugin from "fraq-plugin-chatsalt";

ctx.install(AiPlugin, {
  // 在这里传入 AiPlugin 的配置选项
});
ctx.install(KyselyPlugin, {
  // 在这里传入 KyselyPlugin 的配置选项
});
ctx.install(ChatsaltPlugin, {
  // 在这里传入 ChatsaltPlugin 的配置选项
});
```

`ChatsaltPlugin` 有如下配置项：

- `persona`：角色设定文本，推荐使用 Markdown 格式。角色设定文本会在每次对话开始时被注入到上下文中。
- `chatModel`：用于对话的语言模型，默认使用 `ctx.ai.model()` 获取的模型。
- `visionModel`：用于图像识别的语言模型，默认使用 `chatModel`。
- `contextWindow`：上下文窗口大小，即提供给大模型的消息总数，默认值为 20。
- `maxForwardDepth`：若上下文中包含合并转发消息，则最多展开的层数，默认值为 0，即不展开。
- `temperature`：用于对话的温度参数，默认值为 0.7。
- `maxToolSteps`：在调用工具时，最多允许的步骤数，默认值为 10。
- `memory`：有关记忆的配置项：
  - `enabled`：是否启用记忆功能，默认值为 `true`。
  - `maxWindow`：记忆窗口大小，即在对话中最多注入的记忆条数，默认值为 20。
  - `maxScopeCount`：对于每个对话场景，最多允许的记忆条数，默认值为 50。
