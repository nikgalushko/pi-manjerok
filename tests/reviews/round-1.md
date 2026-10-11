# Ревью тестов — цикл 1

Дата: 11 октября 2026 года. Проверены полный `state-machine-test-plan.md`, production diff, все тестовые файлы, оба helper, scripts, README и evidence. Reviewer самостоятельно тесты и production не редактировал.

## Находки

### R1-01 — P1 — C01/C02 не проверены для каждой роли

Статус: **fixed**. Проверено reviewer после нового fixer: 15 случаев всех ролей × nonempty/null/empty; обе ранее выжившие worker/verifier omission-мутации теперь завершаются exit 1 на `C01 exact model for worker/verifier`, `ERR_ASSERTION` (по одному адресному тесту, без timeout/import failures).

Ссылка: [tests/workflow-contracts.test.mjs:5](/Users/ng/Documents/github/pi-manjerok/tests/workflow-contracts.test.mjs:5), конфигурация на строке 7. Связанный общий assertion: [tests/helpers/workflow-harness.mjs:111](/Users/ng/Documents/github/pi-manjerok/tests/helpers/workflow-harness.mjs:111).

Требование: C01 — непустой `modelParam` каждой роли передаётся без изменения; C02 — при `null` и пустой строке `model` отсутствует и не наследуется от другой роли.

Непустая модель задана только scout, senior и reviewer. Для worker единственный вариант — пустая строка, для verifier — null; во всех остальных сценариях у них также null. Поэтому assertion, принимающий корректную передачу модели worker/verifier, никогда не исполняется с непустой моделью этих ролей.

Воспроизведение: reviewer создал две отдельные временные копии и заменил строку `if (typeof roleCfg.modelParam === "string" && roleCfg.modelParam) item.model = roleCfg.modelParam;` соответственно на:

```js
if (role !== "worker" && typeof roleCfg.modelParam === "string" && roleCfg.modelParam) item.model = roleCfg.modelParam;
// Вторая независимая копия:
if (role !== "verifier" && typeof roleCfg.modelParam === "string" && roleCfg.modelParam) item.model = roleCfg.modelParam;
```

Полный `node --test --test-reporter=tap tests/*.test.mjs` в обеих копиях: **373 passed, 0 failed**. Это семантическая потеря явной модели в двух ролях, которую набор не обнаруживает. Копии удалены.

Требуемая правка: параметризовать C01/C02 для всех пяти ролей. Проверить непустые разные значения с thinking suffix, null и пустую строку для каждой роли; сохранить другие роли с отличающимися моделями, чтобы видеть нежелательное наследование. Assertions должны читать параметры запуска. Добавить или документированно выполнить направленные мутации как минимум для обнаруженных пропусков worker/verifier, с падением на передаче `model`, не на маршруте или импорте. Production менять не требуется.

### R1-02 — P1 — отсутствует внешний таймаут тестового процесса

Статус: **fixed**. Проверено reviewer после нового fixer: `npm test` запускается через независимый `scripts/run-tests.mjs` watchdog; адресный тест с реальным sync-hang fixture возвращает 124, grandchild heartbeat останавливается; обычные успех/assertion failure сохраняют exit 0/1.

Ссылки: [package.json:38](/Users/ng/Documents/github/pi-manjerok/package.json:38), [tests/helpers/workflow-harness.mjs:80](/Users/ng/Documents/github/pi-manjerok/tests/helpers/workflow-harness.mjs:80), [tests/helpers/workflow-harness.mjs:83](/Users/ng/Documents/github/pi-manjerok/tests/helpers/workflow-harness.mjs:83).

Требование раздела 2: «Ограниченное число вызовов и короткий таймаут тестового процесса»; критерий завершения плана: каждый тест имеет защиту от зависания. Это требование к локальному набору тестов, а не исключённый из плана production timeout.

`npm test` запускает `node --test` без внешнего watchdog. Таймауты `node:test` и `Promise.race` обслуживаются тем же event loop, что и исполняемый скрипт. Синхронная регрессия вроде `while (true) {}` блокирует их; кроме того, harness запускает функцию до создания своего timer. Лимит вызовов помогает только при достижении `runs.all`.

Воспроизведение: временный `.test.mjs` импортирует настоящий harness и исполняет:

```js
test('sync hang', { timeout: 100 }, async () => {
  await runScenario([], {}, { script: 'while(true){}', timeoutMs: 50 });
});
```

Запуск `node --test <temporary-test>` через независимый `spawnSync` с `timeout: 1000` не завершается по внутренним лимитам 50/100 ms: получен **ETIMEDOUT**, output пуст. Процесс ограничила только внешняя проверка reviewer. В обычном `npm test` такого ограничения нет.

Требуемая правка: ограничить тестовый процесс отдельным watchdog, который работает независимо от event loop исполняющего тесты процесса, завершает зависший процесс и возвращает ненулевой код; учитывать дочерние процессы Node test runner. Можно добавить небольшой встроенный Node runner, который продолжает запускать `node --test tests/*.test.mjs` без зависимостей. Добавить контролируемую проверку зависшего синхронного fixture в отдельном процессе с коротким заданным пределом, чтобы сам регрессионный тест не зависал. Объяснить границу этой защиты в README. Production timeout и sandbox не менять.

## Проверки исходной реализации

- Node v24.1.0, npm 11.7.0; тестовых зависимостей, pi и моделей не использовалось.
- `npm test`: **373 passed, 0 failed**, около 218 ms. Лог: `/private/tmp/manjerok-review-r1-tests.log`.
- `npm run test:explore`: **32 configurations, 2746 completedScenarios, 0 truncatedBranches**; обязательные семейства проверяются для каждой конфигурации. Лог: `/private/tmp/manjerok-review-r1-explore.log`.
- `npm run test:mutations`: **11/11** заявленных семантических мутаций обнаружены на ожидаемых ERR_ASSERTION; отдельно просмотрены anchors, compile/import, проверки статуса процесса и защита от признания timeout обнаружением. Лог: `/private/tmp/manjerok-review-r1-mutations.log`.
- `git diff --check`: passed.
- Маршруты T01–T15, бюджеты B01–B09, direct/native протокол V01–V13, матрица F01–F07 с strict `ok` и childRuns, пары evidence C07 и bounded history C09: дополнительных actionable расхождений в этом цикле не найдено.
- Из production string review видна только механическая extraction и отдельное исправление scout BLOCKED: output сохраняется до return, а detail не сообщает `context gathered` для блокировки. Existing named export сохранён.
- CI в checkout отсутствует; подключать к несуществующему pipeline нечего.

## Ограничения

Минимальная Node 22.19.0 в этом цикле не запускалась; выполнен локальный прогон на Node 24.1.0. Реальный sandbox pi-subagents, качество моделей, runtime deadline и RPC вне согласованного FSM-набора и не оценивались. Для диагностики временного зависшего subprocess sandbox не позволил прочитать process inventory через `ps`/`pgrep`; assertion об отсутствии остальных системных процессов не делался.

## Передача исправлений

Один новый fixer `/root/review_tests_round_1/fix_review_round_1` исправил обе находки и сохранил [tests/reviews/fixes-round-1.md](/Users/ng/Documents/github/pi-manjerok/tests/reviews/fixes-round-1.md). Production и пользовательский план не менял.

Адресная проверка reviewer после исправлений:

- `node scripts/run-tests.mjs '--test-name-pattern=C01/C02|test watchdog' tests/workflow-contracts.test.mjs tests/workflow-watchdog.test.mjs`: **17 passed, 0 failed**, около 982 ms. Лог: `/private/tmp/manjerok-review-r1-targeted.log`.
- Независимый повтор двух исходных omission-мутаций во временных копиях: каждая компилируется/исполняется выбранным `C01/C02 <role> nonempty` тестом и падает **1 failed / 0 passed** на точном model assertion. Копии удалены.
- `git diff --check`: passed.
- Fixer также выполнил полный набор: **389/389**, M01 **13/13**, E01 **32/2746/0**; его результаты и ограничения сохранены в отдельном отчёте и логах. Reviewer не запускал второй широкий review в этом цикле.

Открытых находок текущего цикла **нет**. Остались обозначенные границы проверки: Node 22.19.0 и Windows-ветка watchdog локально не запускались; watchdog не представляет sandbox и не отслеживает процессы, намеренно покинувшие группу/дерево. Это ограничения проверки, не неустранённые требования согласованного FSM-контракта.

Состояние готово для следующего независимого reviewer, если родительский агент продолжит цикл в пределах максимума 3.
