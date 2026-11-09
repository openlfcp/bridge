# Helper: живая проверка EventKit (для владельца)

Что проверяется только на Mac с доступом к Напоминаниям (TCC нажимает человек). Остальное покрыто без TCC:
- `helper/scripts/build.sh` — тесты HelperCore на memory-бэкенде;
- `helper/scripts/smoke.mjs` — приложение целиком: `status`, `serve`, `open` + FIFO, выход при смерти host-pid.

Живой прогон пишет **только** в новый список `LFCP Verify · Helper <время>` (verification-режим, D-010 r4 §7.6). Реальные
списки не трогаются: helper отказывает в записи вне `LFCP Verify · …`, это проверяется на шаге 2.

## Команды (копипастой)

```sh
cd ~/dev/openlfcp-work/mvp-0.5/bridge/helper
scripts/build.sh
scripts/sign-dev.sh
node scripts/smoke.mjs
node scripts/live-check.mjs
```

- `scripts/sign-dev.sh` один раз создаёт в login keychain самоподписанный сертификат «LFCP Bridge Dev» и подписывает им
  приложение. При первой подписи macOS может спросить «codesign wants to use the key…» → **Always Allow**.
- `live-check.mjs` запускает приложение через `open`, как это будет делать мост. При первом запуске появится диалог
  «LFCP Reminders Helper» → Напоминания → **Разрешить**.
- Ручные шаги выделены жёлтым, после каждого нужно нажать Enter. Ввод `s` + Enter пропускает шаг.
- Результат — `helper/build/live-check-<время>.json`, его нужно передать обратно.
- Без iPhone и ручных шагов: `node scripts/live-check.mjs --no-manual`.

После прогона удали список «LFCP Verify · Helper …» в Reminders вручную: helper списки не удаляет.

## Что проверяет `live-check.mjs`

| # | Проверка | Как |
|---|---|---|
| 1 | Приложение — свой субъект TCC (родитель `launchd`), доступ выдан ему, а не Terminal | `ready.parentPath`, `access.request` |
| 2 | Гейт записи: без `hello writes` → `writes_disabled`; в verification — только `LFCP Verify · …` | `lists.create` |
| 3 | `lists.create`, повтор названия → `list_exists` | — |
| 4 | create: `written` = прочитанное; идемпотентность по ссылке; полный снимок | `items.create`, `items.snapshot` |
| 5 | update с текущим `rev`; устаревший → `conflict_changed`; `rev` из ответа = `rev` записи | `items.update`, `items.get` |
| 6 | **Ручной.** Время 09:00, заметка и будильник, поставленные человеком, переживают смену даты мостом (B2, B15); `dueDate: null` → `personal_conflict` (B12) | iPhone + `items.update` |
| 7 | **Ручной.** `restoreUrl` заполняет очищенный URL и не трогает URL, вписанный человеком | iPhone + `items.restoreUrl` |
| 8 | Маркеры: создание (выполненная запись), идемпотентность, retire только точного маркера | `markers.*` |
| 9 | `EKEventStoreChanged` после своей записи и после правки с iPhone (задержка) | события `changed` |
| 10 | **Ручной.** `sleep` / `wake` от NSWorkspace | сон Mac на ~30 с |

## Дополнительно, вне скрипта

1. **Подпись переживает пересборку (O6).** После успешного прогона выполни:
   ```sh
   scripts/sign-dev.sh
   node scripts/live-check.mjs --no-manual
   ```
   Второго диалога TCC быть не должно, первая проверка — `full Reminders access granted`. Если диалог появился —
   записать: значит, TCC не принял стабильную подпись.
2. **Stale-object, `-3002`, задержки, повторы** — прогон R-001 из спайка (у helper то же поведение EventKit):
   ```sh
   cd ~/dev/openlfcp-work/mvp-0.5/r-001
   ./run-live.sh --move-test
   ```
   Для мостового гейта (§7.6) из его `results.json` важны три значения:
   - `questions.alarms.staleObjectWrite.userNotesPreserved`;
   - `questions.alarms.notesUntouched`;
   - `questions.identity.timeline`.
3. **TCC в настройках.** Системные настройки → Конфиденциальность и безопасность → Напоминания: там должен быть
   «LFCP Reminders Helper», а не Terminal. Если выключить доступ при работающем helper, придёт событие `access_changed`.

## Что не проверяется нигде, кроме живого прогона

- Что `requestFullAccessToReminders` из LSUIElement-приложения, запущенного через `open -g`, показывает диалог поверх окон.
- Что `NSWorkspace` присылает `didWake` / `willSleep` процессу без окон (`NSApplication.shared`, `.accessory`).
- Что EventKit сохраняет только изменённые свойства. При записи `title` / `priority` / `completed` / даты notes, время и
  будильники не меняются (шаг 6, плюс stale-object из R-001).
- `com.apple.reminderkit -3002`: по заказу не воспроизводится. Повтор с `reset()` проверен только unit-тестом политики.
