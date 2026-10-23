/**
 * dsh-first-prompt-bar 宿主半。从 0.3.0 起它**什么都不做**：界面和"读完整历史"都在浏览器半
 * （lib/client.js）——那边直接用官方远程接口 ctx.remote.session.page 跟宿主的数据面翻页读史，
 * 不需要我们再转一手。
 *
 * 为什么不走"宿主读日志"这条路：试过两版。0.2.0 用 ctx.get('sessionQuery') 去碰，0.2.1 老老实实
 * 把它写进 inject，两次都拿不到 sessionQuery：它是 agent 那一层才起来的服务（官方用它的
 * dsh-tool-session-query 也是挂在那一层），我们这个挂载层级等不到它，RPC 就只能一直没人应答。
 * 读史挪到浏览器这边，少一处会随升级变动的地方。
 *
 * 这个文件还得留着：cordis.patch.yml 需要一个宿主条目才能把包装起来。apply 只写一行日志，
 * 好让 harness.log 里能看出"插件确实挂载上了"——出问题时第一眼就看这里。
 */

export const name = 'dsh-first-prompt-bar';

// 什么都不依赖：任何版本的宿主都能挂载它，不会因为缺服务而一直挂着不上。
export const inject = [];

var logged = false;

export function apply(ctx) {
  if (logged) return;
  logged = true;
  try {
    if (ctx && ctx.logger && typeof ctx.logger.info === 'function') {
      ctx.logger.info('[dsh-first-prompt-bar] 宿主半已挂载（读历史与界面都在浏览器半）');
    } else {
      console.info('[dsh-first-prompt-bar] host half applied; all logic lives in the browser half');
    }
  } catch (error) {}
}
