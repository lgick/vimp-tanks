// Команды, которые раньше разбирал сам движок. Своих команд у движка больше
// нет: CommandProcessor — только реестр, и весь набор, доступный игроку,
// объявляет игра (HostPlugin.chatCommands). Одно и то же имя в разных играх
// может делать разное или отсутствовать вовсе — танкам нужны все пять.
//
// Коды системных сообщений здесь движковые (RANK, COMMANDS_NOT_FOUND — группа
// 'c'), тексты лежат в modules.chat.params.messages (src/config/client.js).
//
// ctx — контекст меты движка: participants, chat, scripted, roundManager,
// voteCoordinator, timerManager, playerDataSync, teams, spectatorTeam,
// spectatorId, isDevMode. Worker-safe.

// mm:ss из миллисекунд
function formatTime(ms) {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = String(Math.floor(totalSeconds / 60)).padStart(2, '0');
  const seconds = String(totalSeconds % 60).padStart(2, '0');

  return `${minutes}:${seconds}`;
}

/// '/name <ник>' — проверку и рассылку делает движок (RoundManager сам шлёт
/// сообщения группы 'n')
export const nameCommand = {
  name: '/name',

  handler(ctx, gameId, args) {
    ctx.roundManager.changeName(gameId, args.join(' '));
  },
};

/// '/nr' — новый раунд, только в dev-сборке
export const newRoundCommand = {
  name: '/nr',

  handler(ctx, gameId) {
    if (ctx.isDevMode) {
      ctx.roundManager.initiateNewRound();
    } else {
      ctx.chat.pushSystemByUser(gameId, 'COMMANDS_NOT_FOUND');
    }
  },
};

/// '/timeleft' — сколько осталось до смены карты
export const timeLeftCommand = {
  name: '/timeleft',

  handler(ctx, gameId) {
    ctx.chat.pushSystemByUser(gameId, [
      formatTime(ctx.timerManager.getMapTimeLeft()),
    ]);
  },
};

/// '/mapname' — название текущей карты
export const mapNameCommand = {
  name: '/mapname',

  handler(ctx, gameId) {
    ctx.chat.pushSystemByUser(gameId, [ctx.roundManager.currentMap]);
  },
};

/// '/rank' — ранг игрока с auth-сервиса (движок держит его в PlayerDataSync)
export const rankCommand = {
  name: '/rank',

  handler(ctx, gameId) {
    ctx.chat.pushSystemByUser(gameId, 'RANK', [
      ctx.playerDataSync.getRank(gameId),
    ]);
  },
};
