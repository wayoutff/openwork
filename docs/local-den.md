# Personal Den без Docker

Локальная private self-hosted установка из исходников текущего checkout.
Только один Mac, loopback binding, обычная email/password авторизация.
Не является публичным production deployment или полностью офлайн AI.

## Адреса

- Web: `http://localhost:3005`.
- API: `http://localhost:8788`.
- MySQL 8.4: `127.0.0.1:13306`; не порт стандартного MySQL.
- Организация: Personal OpenWork. Локальный владелец: `owner@openwork.local`.

## Запуск и остановка

```bash
bash "$HOME/Downloads/homelab/openwork/scripts/den-local.sh"
bash "$HOME/Downloads/homelab/openwork/scripts/den-local.sh" status
```

Первая команда остаётся в терминале, запускает три сервиса и завершает их по
Ctrl+C без удаления данных. Не запускать второй экземпляр при занятых портах.
В текущей установке стек запущен как persistent tracked process в Kilo;
для остановки использовать Stop этого процесса. Автозапуск при входе в macOS
не настраивался. После перезагрузки запустить команду выше.

Секреты/случайный пароль владельца находятся только в
`~/.local/share/openwork-personal-den/private.json` (0600), каталог 0700.
База, socket и MySQL logs находятся рядом. Эти файлы вне репозитория.
Не публиковать их содержимое. Сохранить private.json при backup базы:
потеря encryption key делает сохранённые зашифрованные подключения недоступными.
Для ручного входа в web используйте ownerEmail и ownerPassword из этого файла.

## Desktop

Подписанный OpenWork Local подключён через штатный одноразовый handoff.
Organization server: `http://localhost:3005`, API: `http://localhost:8788`.
Официальная установка и её аккаунт не изменены. Свой LiteLLM остаётся в
локальном runtime; ключи не переносились в Den и не сохранены в Git.

На собственном Den встроенная OpenWork Free может отсутствовать в каталоге.
Для локальных задач выбирать модель своего LiteLLM. Ошибка
`provider_tool_projection_missing` с `modelExists=false` относится к выбранной
модели, а не к адресу Den или разрешениям macOS. Состояние проверки подключённых
инструментов должно пересчитываться по фактической модели текущего чата.

В launcher Den явно включены operator flags COMPUTER_USE, GIT_CHANGES_PANEL,
SESSION_FILE_BROWSER. Удалённые компьютеры выключены. После upstream-синхронизации
2026-10-31 отдельный computerUseBackground удалён upstream: background delivery
теперь часть Computer Use на поддерживаемых parallel-адаптерах. Keep agent window
in front сохраняется для foreground-шагов, но не принуждает background-действия
выводить окно вперёд.
Это политика собственного self_hosted deployment, не обход hosted-политики.
Public signup закрыт, bootstrap первого администратора после регистрации
недоступен. Reset базы для повторной регистрации запрещён.

## Первичная подготовка на другом Mac

Нужны Homebrew MySQL 8.4, Node из .nvmrc, Corepack/pnpm и установленные зависимости
форка. Это не автоматический установщик для произвольной ОС.

1. Собрать `pnpm --filter @openwork-ee/den-api run build:workspace-dependencies`.
2. `node scripts/den-local.mjs init` создаёт приватные секреты и отдельный datadir.
3. `node scripts/den-local.mjs mysql` сначала запускает БД только через Unix socket.
4. В другом терминале `node scripts/den-local.mjs provision` устанавливает пароль
   root и пользователя openwork с доступом только к этой базе.
5. Перезапустить MySQL, затем `node scripts/den-local.mjs migrate`.
6. Остановить отдельный MySQL и запустить общий `bash scripts/den-local.sh`.
7. `node scripts/den-local-enroll.mjs` использует bootstrap/sign-in/handoff API
   для локального владельца и подписанного renderer на порту 15374; CDP-порт
   задаётся OPENWORK_SIGNED_CDP_PORT (по умолчанию 9225). Скрипт меняет авторизацию
   только этого renderer, токены и пароль не выводит.

## Обновления и границы

Перед обновлением исходников делать backup базы и private.json. Сервисы не
запускают миграции автоматически: остановить API/Web, обновить build artifacts,
выполнить migrate при работающем MySQL, затем запустить стек. Не использовать
drizzle push или удаление datadir вместо миграций.

Используется developer Next/tsx, не оптимизированный deployment. Cloud VM
provisioner — stub, внешние sandbox/SSO/email не настроены. Telemetry backend
none и Next telemetry отключены; это не доказательство отсутствия всех фоновых
сетевых обращений. Модели через внешний LiteLLM по-прежнему требуют сети.

Den относится к `ee/LICENSE`: допускается development/testing и использование
до пяти пользователей с указанными там исключениями Enterprise Features.
Наличие feature flag не изменяет лицензионные условия.
