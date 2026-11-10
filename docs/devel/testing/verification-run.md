# Первая живая проверка моста на Mac (R-023, verification-режим)

Для владельца. Мост целиком на настоящих Напоминаниях и настоящей секции, но **только** на тестовом списке
`LFCP Verify · …` и тестовой секции (D-010 r4 §7.6, B16). Обычные списки и секции не трогаются:
- запись разрешена только verification-привязке;
- helper в режиме `verification` отказывает в записи вне `LFCP Verify · …`.

Время: около 40 минут. Нужны:
- Mac с собранным и подписанным `LFCP Reminders Helper.app` (см. `helper-live-checklist.md`, шаги build и sign-dev);
- iPhone с тем же Apple ID (Напоминания);
- Obsidian с плагином LFCP — устройство, которое управляет секциями.

Все команды — копипастой в Terminal. Восклицательных знаков в командах нет.

## 0. Подготовка

В Obsidian создай **тестовую** секцию `Verify` (пустую). Дальше всё делаем только с ней.

```sh
cd ~/dev/openlfcp-work/mvp-0.5/bridge
pnpm install --frozen-lockfile
pnpm build
alias lfcp-bridge="node $PWD/packages/host/dist/cli.js"
lfcp-bridge --version
lfcp-bridge doctor --request-access
```

`doctor --request-access` покажет системный диалог «LFCP Reminders Helper» → Напоминания → **Разрешить**.
Повторный `lfcp-bridge doctor` должен показать `ok` у доступа к Напоминаниям.

## 1. Pairing (мост — служебное устройство, B-001)

В Obsidian: плагин LFCP → устройства → добавить служебное устройство → доступ к секции `Verify` → **скопировать
ссылку**. Затем на Mac:

```sh
pbpaste | lfcp-bridge pair --label "Mac bridge" --section Verify
```

1. Команда печатает отпечаток; сравни его с экраном Obsidian и подтверди там.
2. Ответ `paired: installation …` — готово.
3. Ответ `not approved yet` — подтверди в Obsidian и повтори команду из этого же ответа; в ней указан
   `--installation …`.

Проверка:

```sh
lfcp-bridge sections
```

В списке есть `Verify`, без `(not stored yet)`.

## 2. Привязка, dry-run, approve

```sh
lfcp-bridge verify --section Verify
```

В Напоминаниях появляется список **«LFCP Verify · Verify»**. В нём одно выполненное напоминание-маркер «LFCP bridge ·
не удалять» — его не удаляй. Команда печатает id привязки; дальше он обозначен `<binding>`.

```sh
lfcp-bridge dry-run <binding>
```

Секция пуста, поэтому план пуст: `would: create 0 …`. Строки `guards that would stop it` быть не должно.

```sh
lfcp-bridge approve <binding>
lfcp-bridge status
```

`status` показывает привязку `active (verification)` без holds.

## 3. Запуск

```sh
lfcp-bridge run
```

Оставь окно открытым: процесс работает, пока не нажмёшь Ctrl-C. Во втором окне Terminal:

```sh
alias lfcp-bridge="node $HOME/dev/openlfcp-work/mvp-0.5/bridge/packages/host/dist/cli.js"
lfcp-bridge log --limit 30
```

## 4. Чек-лист

Каждое действие подожди до 30 с. На iPhone список виден не сразу: синхронизация iCloud идёт своим ходом. Если
ничего не происходит минуту, запиши номер шага и посмотри `lfcp-bridge log --limit 30` и `lfcp-bridge status`.

| # | Где | Что сделать | Что должно произойти |
|---|---|---|---|
| 1 | Obsidian | в `Verify` новая задача «Купить молоко» со сроком на завтра | на iPhone в «LFCP Verify · Verify» напоминание «Купить молоко» на завтра, **без времени**; в его поле URL ссылка `lfcp://task/…` |
| 2 | Obsidian | переименовать в «Купить овсяное молоко» | напоминание переименовано |
| 3 | iPhone | переименовать напоминание в «Купить хлеб» | в Obsidian задача называется «Купить хлеб» |
| 4 | iPhone | добавить время 18:00 и будильник, написать заметку | в Obsidian срок прежний — дата без времени. Время, будильник и заметка остаются на iPhone |
| 5 | iPhone | перенести дату на послезавтра | в Obsidian срок — послезавтра |
| 6 | Obsidian | переименовать задачу ещё раз | на iPhone новое название; **время, будильник и заметка из шага 4 на месте** |
| 7 | iPhone | приоритет «высокий» | в Obsidian приоритет high |
| 8 | iPhone | отметить выполненным | в Obsidian задача done с сегодняшней датой |
| 9 | Obsidian | снова открыть задачу (todo) | на iPhone напоминание снова не выполнено |
| 10 | iPhone | новое напоминание «Позвонить маме» в этом списке | в Obsidian в конце `Verify` задача «Позвонить маме», без назначения; через проход в URL напоминания появляется ссылка `lfcp://task/…` |
| 11 | iPhone | в напоминании «Позвонить маме» заменить URL на свой `https://example.com` | URL остаётся твоим; мост его больше не трогает, даже если потом очистить поле |
| 12 | Obsidian | отменить задачу «Позвонить маме» (cancelled) | на iPhone напоминание выполнено; в Obsidian задача остаётся cancelled, а не done |
| 13 | iPhone | удалить напоминание «Купить хлеб» | в Obsidian задача остаётся; в журнале: «You deleted the reminder…»; заново не создаётся |
| 14 | Obsidian | новая задача «Тест 1», дождаться напоминания; потом на iPhone перенести его в другой список | задача остаётся; в журнале «You moved the reminder to another list…»; в другом списке напоминание не трогается |
| 15 | Obsidian | удалить задачу (с напоминанием) | напоминание остаётся на iPhone; в журнале «The task was deleted in the shared section…» |
| 16 | Terminal | `lfcp-bridge stop`, потом переименовать задачу в Obsidian | напоминание **не** меняется |
| 17 | Terminal | `lfcp-bridge resume` | в течение минуты напоминание переименовано |
| 18 | Obsidian | создать 4 задачи, дождаться 4 напоминаний; потом удалить все 4 задачи сразу | напоминания остаются; `lfcp-bridge status` показывает `holds: guard_mass_unlink` (и, возможно, `guard_count_drop`); больше ничего не синхронизируется |
| 19 | Terminal | `lfcp-bridge resume --accept guard_mass_unlink --binding <binding>` (и так же для каждого hold из `status`) | holds сняты, проход идёт; `status` без holds |
| 20 | Terminal | Ctrl-C в окне `run`, затем снова `lfcp-bridge run` | процесс останавливается и запускается без ошибок; шаг 2 ещё раз работает |

Ни на одном шаге мост не должен удалить напоминание, будильник, время или заметку и не должен писать в другие списки.

## 5. Что прислать

```sh
lfcp-bridge status > ~/Desktop/verify-status.txt
lfcp-bridge log --limit 300 > ~/Desktop/verify-log.txt
sw_vers -productVersion
```

Пришли оба файла, версию macOS и номера шагов, где ожидаемое не произошло; где сможешь — со скриншотом. По этому
отчёту выставляется `writesVerified` для этой сборки helper и версии macOS (§7.6). Пока его нет, обычные привязки
работают только в dry-run.

## 6. Уборка

```sh
lfcp-bridge unbind <binding>
```

Список «LFCP Verify · Verify» и напоминания в нём остаются: мост ничего не удаляет. Удали их в Напоминаниях вручную.
Тестовую секцию в Obsidian удали или оставь.
