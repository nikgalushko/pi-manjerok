# Ревью тестов — цикл 2

Дата: 11 октября 2026 года. Второй независимый reviewer прочитал весь `state-machine-test-plan.md`, production diff, все тесты, helpers, scripts, README, evidence, `round-1.md` и `fixes-round-1.md`. Production, тесты и пользовательский план reviewer не редактировал. Скрипты проверки заново сгенерировали штатные exploration/mutation evidence.

## Находки

**None — actionable ошибок или неисполненных требований согласованного плана не найдено.** Новый fixer в этом цикле не запускался. Открытых находок текущего цикла нет.

## Проверенные требования

- T01–T15: явные очереди ролей, точные terminal status и три счётчика; существенные переходы, полный структурный trace T07, отсутствие дополнительных вызовов. После `FINDINGS` проверяются новая реализация и verifier перед reviewer.
- B01–B09: лимиты 1, 2 и 3, независимые бюджеты, сохранение worker/senior counters после PASS и общего reviewer counter после эскалации. Дополнительные проверки чувствительности для senior/review `>=` описаны ниже.
- V01–V13: полный строковый протокол по всем ролям и обоим verifier/reviewer маршрутам; LF/CRLF, последний clean verdict, direct/native reviewer, приоритет direct и fallback native, malformed/foreign/case/tail inputs, разбор полного output до truncation. Reviewer native `BLOCK` отличается от инфраструктурного `BLOCKED`.
- F01–F07: missing result, строгое `ok === true`, stopped priority, ошибка протокола, диагностические маркеры и accumulated counters 1/1/1 на девятом child run; fallback полей результата проверяется на fixtures, которые harness не дополняет. Отдельный rejection test требует исходное исключение.
- C01/C02 после первого fixer: все пять ролей × nonempty/null/empty; разные настроенные модели, включая thinking suffix, проверяются по фактическим launch parameters.
- C03–C06: fresh context на каждом verifier/reviewer, уникальные request keys, single-item `runs.all`, управляемый pending Promise, содержательные поля packet и counters до запуска для direct/budget escalation и повторного reviewer.
- C07/C08: проверяются уникальные marker и правильный source во всех перечисленных парах. Первые и повторные результаты имеют разные marker; assertions читают packet до выдачи fixture response. В частности, second implementation и second successful verification проверяются отдельно от наличия старой истории.
- C09/C10: exact last-eight packet evidence и last-six report evidence, порядок и вытеснение; 6000 UTF-16 units с truncation marker, полный task в packets и сокращённый report task, reason/detail limits.
- C11–C13: schema/status/risk/budgets/attempts/childRuns и соответствие events/transitions для всех terminal statuses; frozen args и повторный запуск без старой истории/counters. Не требуется выдуманное final event.
- E01: все 32 конфигурации, следующая роль определяется выполнением настоящего script; попытка вызова сверх budget-derived bound является assertion failure. Сверены все перечисленные инварианты, terminal child responses, observed failure counters, обязательные families для каждой конфигурации и повторный review при R=2. Свежий полный перебор не оставил усечённых ветвей.
- M01: исходный набор запускается до мутантов; каждый изменённый script импортируется и компилируется. Детекция требует exit 1 и ожидаемый `ERR_ASSERTION`; import/syntax/spawn/signal/timeout failures отвергаются. Mutation records содержат конкретные нарушенные ожидания, временные копии удаляются.
- Новый runner: независимый event loop watchdog, expiry exit 124, detached process group cleanup на macOS/Linux, сохранение обычных exit 0/1. Regression fixture действительно зависает синхронно внутри harness в Node test worker; grandchild heartbeat начинается и прекращается после watchdog. Вложенный runner очищает `NODE_TEST_CONTEXT`. Контрольный внешний deadline не принимается за успех watchdog.

## Свежие команды и результаты

Среда: Node **v24.1.0**, macOS. Сторонние пакеты, pi, модели, сеть и пользовательские настройки для прогонов не использовались.

| Команда | Результат |
| --- | --- |
| `npm test` | **389 passed, 0 failed**, 0 skipped/cancelled, около 1.14 секунды |
| `npm run test:explore` | **32 configurations, 2746 completedScenarios, 0 truncatedBranches** |
| `npm run test:mutations` | **13/13** ожидаемых semantic assertion failures |
| `git diff --check` | passed |

Логи: `/private/tmp/manjerok-review-r2-tests.log`, `/private/tmp/manjerok-review-r2-explore.log`, `/private/tmp/manjerok-review-r2-mutations.log`. Постоянные результаты: `tests/evidence/exploration.json` и `tests/evidence/mutations.md`.

## Дополнительная независимая проверка чувствительности

Reviewer создал отдельные временные копии текущего checkout, запускал конкретный тест реальным `node --test`, требовал exit 1 и ожидаемый `ERR_ASSERTION` без process/timeout/import/syntax failures и удалил копии. Результаты:

| Мутация | Тест | Нарушенное ожидание |
| --- | --- | --- |
| `seniorAttempts >= budget` → `>` | B02 senior limit 1 | `child-call bound exceeded`: после первого FAIL лишний senior запрещён |
| `reviewRoundsUsed >= budget` → `>` | B03 review limit 1 | `child-call bound exceeded`: после первых FINDINGS новая реализация запрещена |
| Скрыть последнюю implementation evidence при сборке verifier packet | T12 | `verifier missing worker (attempt 1) evidence T12-fixed` |
| Та же потеря на senior | T13 | `verifier missing senior (attempt 1) evidence T13-fixed` |
| Скрыть последнюю PASS evidence при сборке reviewer packet | T12 | `reviewer missing verifier evidence T12-pass-1` |
| Скрыть только PASS evidence повторного reviewer, сохранив первый PASS | T12 | `reviewer missing verifier evidence T12-pass-2` |
| Та же избирательная потеря повторного PASS на senior | T13 | `reviewer missing verifier evidence T13-pass-2` |

Последние две проверки подтверждают, что наличие предыдущего PASS не заменяет проверку последнего результата.

## Проверка extraction и границы

Reviewer отдельно извлёк и вычислил исходный template literal из `git show HEAD:extensions/manjerok/index.ts`. Получены те же **13713 UTF-16 units** и SHA-256 **029d1be65ac5361ab8796f3973293836125269f1ad747b508dca4ba309ca9998**, что в extraction evidence. Текущий evaluated string побайтно соответствует этому значению после замены ровно трёх исходных scout lines на согласованный diagnostic fix. Иных production behavior изменений не найдено; именованный реэкспорт сохранён.

В checkout нет AGENTS.md и CI configuration. Локально проверена Node 24.1.0; минимальная Node 22.19.0 и Windows `taskkill` branch не запускались. Watchdog не заявляет контроль процессов, намеренно покинувших process group/tree. Реальный pi-subagents sandbox, runtime timeout, RPC/delivery, ограничения инструментов и качество моделей исключены самим планом и не оценивались. Эти границы проверки не являются незакрытыми находками текущего цикла.

Цикл 2 завершён без исправлений. Состояние готово к решению родительского агента о завершении или третьем независимом ревью в установленном пользователем пределе.
