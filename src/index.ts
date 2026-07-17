import { definePlugin, param } from '@fraqjs/fraq';

export const ExamplePlugin = definePlugin({
  name: 'example-plugin', // Change this to your plugin's name
  apply(ctx) {
    // Start coding here!
    ctx.router
      .command('echo')
      .arg('content', param.str())
      .execute((session, { content }) => {
        session.reply(`You said: ${content}`);
      });
  },
});

export default ExamplePlugin; // Also export the plugin as default
