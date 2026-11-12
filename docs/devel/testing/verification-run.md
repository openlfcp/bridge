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

В Obsidian создай **тестовую** секцию `Verify` (пустую) и сделай её **общей** (shared): до `pair` она должна быть
в roster, иначе `pair` ответит `Not in the roster, or ambiguous: Verify`. Дальше всё делаем только с ней.

Задачи в `Verify` пиши **между маркерами секции**. В пустой секции маркеры стоят вплотную, и в Live Preview курсор
после заголовка легко оказывается за закрывающим маркером: такая задача молча остаётся вне секции, хотя панель
показывает «synced». Срок ставь в формате Tasks: `📅 2026-11-13`. Формат Dataview `[due:: …]` плагин пока не
понимает: задача уходит без срока, и фильтр `default` её не берёт.

`lfcp-bridge` здесь — функция оболочки, а не alias: alias, заданный во вставленном в zsh блоке, в этом же блоке ещё
не действует.

```sh
cd ~/dev/openlfcp-work/mvp-0.5/bridge
pnpm install --frozen-lockfile
pnpm build
lfcp-bridge() { node "$HOME/dev/openlfcp-work/mvp-0.5/bridge/packages/host/dist/cli.js" "$@"; }
lfcp-bridge --version
lfcp-bridge doctor --request-access
```

`doctor --request-access` покажет системный диалог «LFCP Reminders Helper» → Напоминания → **Разрешить**.
Повторный `lfcp-bridge doctor` должен показать `ok` у доступа к Напоминаниям.

## 1. Pairing (мост — служебное устройство, B-001)

В Obsidian: `Cmd+P` → **Shared Tasks: Add my other device…** → **Copy link**. Окно не закрывай. (В настройках
плагина пункта «устройства» нет.) Затем на Mac:

```sh
pbpaste | lfcp-bridge pair --label "Mac bridge" --section Verify
```

1. Команда печатает отпечаток. В том же окне Obsidian нажми **Review**, сравни отпечаток с напечатанным и подтверди,
   оставив доступ только к `Verify`.
2. Ответ `paired: installation …` — готово.
3. Ответ `not approved yet` — подтверди в Obsidian, скопируй ссылку ещё раз и выполни команду, которую напечатал
   этот ответ: она полная, с `--installation`, кавычками и твоей секцией.

Проверка:

```sh
lfcp-bridge sections
```

В списке есть `Verify`, без `(not ready)`.

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
lfcp-bridge() { node "$HOME/dev/openlfcp-work/mvp-0.5/bridge/packages/host/dist/cli.js" "$@"; }
lfcp-links() { sqlite3 -readonly "$HOME/Library/Application Support/org.openlfcp.bridge/bridge.sqlite" "SELECT rem_title_snapshot, origin, state, url_state, updated_at FROM links ORDER BY created_at"; }
lfcp-bridge log --limit 30
```

`lfcp-links` только читает базу моста и показывает связи задач с напоминаниями: название на момент, когда связь
появилась (при переименованиях оно не меняется), откуда пришла связь (`lfcp` или `apple`), состояние, `url_state` и
время последнего изменения. Нужна она потому, что ссылку `lfcp://task/…` мост
пишет в `EKReminder.url`, а Напоминания (iOS и macOS 26) это поле **не показывают**. Поле «URL» в карточке
напоминания — другое хранилище, EventKit его не видит. Связь проверяй через `lfcp-links` и `log`, а не по карточке.

## 4. Чек-лист

После `approve` первые 24 часа действуют строгие лимиты (§7.2): больше одной отвязки или трёх новых задач из
Напоминаний в час — стоп всей привязки до `resume --accept`. Шаги 14, 16 и 19 этот стоп ожидают и показывают, как его
принять; это проверка защиты, а не сбой.

Каждое действие подожди до 30 с. На iPhone список виден не сразу: синхронизация iCloud идёт своим ходом. Если
ничего не происходит минуту, запиши номер шага и посмотри `lfcp-bridge log --limit 30` и `lfcp-bridge status`.

| # | Где | Что сделать | Что должно произойти |
|---|---|---|---|
| 1 | Obsidian | в `Verify`, между маркерами, новая задача «Купить молоко» со сроком на завтра (`📅`) | на iPhone в «LFCP Verify · Verify» напоминание «Купить молоко» на завтра, **без времени**; `lfcp-links` показывает `Купить молоко|lfcp|linked|ours|…` |
| 2 | Obsidian | переименовать в «Купить овсяное молоко» | напоминание переименовано |
| 3 | iPhone | переименовать напоминание в «Купить хлеб» | в Obsidian задача называется «Купить хлеб» |
| 4 | iPhone | добавить время 18:00 и будильник, написать заметку | в Obsidian срок прежний — дата без времени. Время, будильник и заметка остаются на iPhone |
| 5 | iPhone | перенести дату на послезавтра | в Obsidian срок — послезавтра |
| 6 | Obsidian | переименовать задачу ещё раз | на iPhone новое название; **время, будильник и заметка из шага 4 на месте** |
| 7 | iPhone | приоритет «высокий» | в Obsidian приоритет high |
| 8 | iPhone | отметить выполненным | в Obsidian задача done с сегодняшней датой |
| 9 | Obsidian | снова открыть задачу (todo) | на iPhone напоминание снова не выполнено |
| 10 | iPhone | новое напоминание «Позвонить маме» в этом списке | в Obsidian в конце `Verify` задача «Позвонить маме», без назначения; через проход `lfcp-links` показывает `Позвонить маме|apple|linked|ours|…` (ссылку моста в карточке не видно, см. §3) |
| 11 | iPhone | в карточке «Позвонить маме» вписать в поле «URL» свой `https://example.com`, потом переименовать задачу в Obsidian | поле «URL» карточки — не то, куда мост пишет ссылку: твой адрес остаётся, связь не меняется — строка `lfcp-links` прежняя (`ours`, то же `updated_at` до переименования); переименование доходит до напоминания. Записи `link.user_replaced` в `log` нет |
| 12 | Obsidian | отменить задачу «Позвонить маме» (cancelled) | на iPhone напоминание выполнено; в Obsidian задача остаётся cancelled, а не done |
| 13 | iPhone | удалить напоминание «Купить хлеб» | в Obsidian задача остаётся; в журнале: «You deleted the reminder…»; заново не создаётся. Это первая отвязка за час |
| 14 | Obsidian | новая задача «Тест 1», дождаться напоминания; потом на iPhone перенести его в другой список | **ожидаемо стоп**: первые 24 ч после approve действует строгий лимит — не больше одной отвязки в час (§7.2). `lfcp-bridge status` показывает `holds: guard_mass_unlink`; запись про перенос в журнал пока не приходит, синхронизация привязки стоит целиком |
| 15 | Terminal | `lfcp-bridge resume --accept guard_mass_unlink --binding <binding>` | через несколько секунд проход идёт: в журнале «You moved the reminder to another list…»; в другом списке напоминание не трогается; `status` без holds |
| 16 | Obsidian | новая задача «Тест 2», дождаться напоминания; потом удалить эту задачу | ожидаемо снова `guard_mass_unlink` (третья отвязка за час): `lfcp-bridge resume --accept guard_mass_unlink --binding <binding>`, после этого напоминание остаётся на iPhone, в журнале «The task was deleted in the shared section…» |
| 17 | Terminal | `lfcp-bridge stop`, потом переименовать задачу «Позвонить маме» в Obsidian | напоминание **не** меняется |
| 18 | Terminal | `lfcp-bridge resume` | через несколько секунд (процесс смотрит на команды раз в 2 с) напоминание переименовано |
| 19 | Obsidian | создать 4 задачи, дождаться 4 напоминаний; потом удалить все 4 задачи сразу | напоминания остаются; `lfcp-bridge status` показывает `guard_mass_unlink` и, возможно, `guard_count_drop`; ничего не синхронизируется. Принять каждый hold из `status`: `lfcp-bridge resume --accept <hold> --binding <binding>` — через несколько секунд проход идёт, `status` без holds; в `log` четыре строки `link.task_gone`. **Напоминания остаются — это ожидаемо**: мост ничего не удаляет в Напоминаниях |
| 20 | Terminal | Ctrl-C в окне `run`, затем снова `lfcp-bridge run` | процесс останавливается и запускается без ошибок; шаг 2 ещё раз работает. Напоминания шага 19 по-прежнему в списке — это ожидаемо |
| 21 | Obsidian, iPhone, Terminal | новая задача «Тест 21» со сроком на завтра, дождаться напоминания. `lfcp-bridge stop`; на iPhone **убрать дату** у «Тест 21»; в Obsidian перенести срок «Тест 21» на послезавтра; `lfcp-bridge resume` | обе правки попадают в один проход; по §5.5 побеждает общая задача: напоминание получает дату послезавтра (время и будильник, если были, на месте). В `log`: `info  field.apple_overruled […]  Changed on both sides: the shared task's due was kept; your Reminders value was null`. Hold нет. Обратный порядок — см. замечание к шагу 21 |
| 22 | Obsidian, Terminal | новая задача «Тест 22» со сроком на завтра, дождаться напоминания. Ctrl-C в окне `run`, затем там же `LFCP_BRIDGE_FAULT=lose-next-write-answer lfcp-bridge run`. В Obsidian переименовать задачу в «Тест 22 б», подождать 30 с. Потом Ctrl-C и снова `lfcp-bridge run` — уже без переменной | Переменная включает разовую имитацию сбоя, и только для записей verification-привязки: следующую запись helper сохраняет и отвечает, мост выбрасывает ответ и убивает helper (SIGKILL) — как падение между сохранением и ответом. В `log` по порядку: `warn  fault.armed  Fault injection is on for this run…` (при запуске); `warn  fault.injected  Fault injection: the answer of items.update (opKey …) was dropped after the helper saved it, and the helper was killed` — запомни opKey, это доказательство, что запись ушла; `warn  effect.lost  The answer of a write to Reminders was lost`; helper перезапускается сам (своей строки в `log` нет); после прохода — `warn  intent.unknown_outcome  Whether a write to Reminders happened is not known: decide in \`lfcp-bridge quarantine\``. На iPhone **одно** напоминание, и оно переименовано в «Тест 22 б» **один раз**: запись прошла, повторно не отправлялась, дубля нет. В Obsidian задача «Тест 22 б» — ничего не потеряно. `status` без holds |
| 23 | iPhone, Obsidian | новое напоминание «Тест 23» с повтором «Каждый день» в этом списке; дождаться задачи в Obsidian; потом переименовать в Obsidian «Позвонить маме» | «Тест 23» появляется задачей в конце `Verify`; в `log`: `info  link.status_locked  The reminder repeats: its completion and due date are not synchronized while it does`. Переименование «Позвонить маме» доходит до напоминания — мост работает дальше. Если helper застрянет на чтении (так было в R-001 после повторяющегося напоминания): в `log` `error  helper.stalled  The Reminders helper gave up on <op> after 30 s: its outcome is unknown. Restarting the helper.`, helper перезапускается сам, синхронизация продолжается — это ожидаемо. Hold `helper_unavailable` (больше трёх перезапусков за 5 минут) — **не** ожидаемо: запиши шаг |

Замечания к шагам 21–23:

- **21, обратный порядок** (дату убрали в Obsidian, на iPhone её поменяли). С фильтром `default` задача без срока и без
  назначения выходит из фильтра (QB10). Поэтому результат — `link.out_of_filter` («The task left this list's filter…»),
  а напоминание остаётся с датой iPhone. Это отвязка: в первые 24 часа ожидай `guard_mass_unlink` и прими его. Если
  задача назначена на тебя, дизайн (§4.5, B12) ждёт конфликт `due_cleared_in_lfcp`: ничего не пишется, дата
  напоминания остаётся. В этой сборке такой конфликт виден только в `lfcp-bridge dry-run <binding>` (строка
  `conflict <task> due: due_cleared_in_lfcp`; перед `dry-run` останови `run` через Ctrl-C). В `log` и `status` его нет:
  это известный пробел, не сбой прогона.
- **22.** Почему `unknown_outcome`, хотя запись на самом деле прошла: helper не ведёт журнал opKey, поэтому после
  потерянного ответа `recover(opKey)` не может узнать, сохранена ли запись. Мост этого не угадывает — ни по
  напоминанию, ни по совпадению полей — и запись не повторяет (B19). Поэтому дубля нет, а намерение уходит в карантин.
  `lfcp-bridge quarantine` в этой сборке ещё нет: название задачи «Тест 22 б» в Напоминания больше не пишется
  (`intent.field_quarantined` в `log`). Это ожидаемо. `LFCP_BRIDGE_FAULT` действует только в процессе `run`, только
  на запись verification-привязки и только один раз. На обычные привязки переменная не влияет.
- **23.** Зависание helper на EventKit и почему каждый вызов ограничен 30 с, разобраны в
  [PR #23](https://github.com/openlfcp/bridge/pull/23) (коммит `ac7ffad`, «fix(helper): bound every EventKit call…»).

Ни на одном шаге мост не должен удалить напоминание, будильник, время или заметку и не должен писать в другие списки.

## 5. Что прислать

```sh
lfcp-bridge status > ~/Desktop/verify-status.txt
lfcp-bridge log --limit 300 > ~/Desktop/verify-log.txt
sw_vers -productVersion
```

Пришли оба файла, версию macOS и номера шагов, где ожидаемое не произошло; где сможешь — со скриншотом.

Потом заполни отчёт: скопируй шаблон и отметь каждый шаг.

```sh
cp ~/dev/openlfcp-work/mvp-0.5/bridge/docs/devel/testing/verification-report.template.json ~/Desktop/verify-report.json
open -e ~/Desktop/verify-report.json
```

- В `helperVersion` и `macOS` впиши, на чём шёл прогон. Если оставить их пустыми, команда ниже откажет и напечатает,
  что запущено на этом Mac (`this machine runs helper … on macOS …`): впиши эти значения, если прогон шёл на них.
- У каждого шага поставь `"ok": true` только если ожидаемое произошло. Иначе оставь `false` и опиши в `note`.
- Названия шагов (`name`) не меняй и шаги не удаляй: команда ищет каждый из 23 шагов шаблона по названию.

Записать результат. Делай это до уборки: нужна verification-привязка.

1. **Сначала останови `run`**: Ctrl-C в его окне. `verify --record` сам запускает helper, чтобы спросить его версию.
   Если `run` работает, у одних и тех же Напоминаний оказываются два helper сразу. Так мост не работает: второй
   helper вне надзора процесса `run`, его `helper.pid` описывает только первый.
2. Затем:

```sh
lfcp-bridge verify --record ~/Desktop/verify-report.json
lfcp-bridge status
```

Команда спрашивает у helper его версию, а у системы версию macOS, и сверяет их с отчётом. `writesVerified` (§7.6)
она выставляет только если в отчёте есть все 23 шага шаблона, все они `ok` и verification-привязка есть. `status` после этого показывает
`writesVerified: helper … on macOS … (recorded …)`. Нет шага, любой шаг не `ok`, другая сборка helper или другая macOS — отказ,
exit 3, ничего не меняется. Пока записи нет, обычные привязки работают только в dry-run. Новая сборка helper или
обновление macOS снова требуют прогона.

## 6. Уборка

```sh
lfcp-bridge unbind <binding>
```

Список «LFCP Verify · Verify» и напоминания в нём остаются: мост ничего не удаляет. Удали их в Напоминаниях вручную.
Тестовую секцию в Obsidian удали или оставь.
