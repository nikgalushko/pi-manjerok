# Исправления после ревью — цикл 1

Дата: 11 октября 2026 года. Исправлены R1-01 и R1-02 из `tests/reviews/round-1.md`; исходный отчёт reviewer не изменялся. Production, `state-machine-test-plan.md`, зависимости и контракт FSM не менялись. Коммитов, запросов к моделям и установки pi не было.

## R1-01 — матрица C01/C02 и адресные мутации

- Единственный смешанный model-сценарий заменён 15 параметризованными случаями: каждая из пяти ролей получает непустой `modelParam` с thinking suffix, `null` и пустую строку.
- Каждый случай запускает все пять ролей. Остальные роли получают разные непустые модели, поэтому проверяется и отсутствие наследования при `null`/пустой строке. Assertions читают записанные параметры настоящих `runs.all` вызовов; senior/verifier/reviewer вызываются повторно.
- Общий assertion передачи модели теперь сообщает `C01 exact model for <role>`, чтобы обнаружение нельзя было спутать с проверкой маршрута.
- В `scripts/check-workflow-mutations.mjs` добавлены M01.12/M01.13: отдельно исключается передача модели worker или verifier из production-строки во временной копии. Обе копии импортированы и скомпилированы, выбранный `nonempty` тест исполняет их и падает именно на `C01 exact model for worker/verifier` с `ERR_ASSERTION`. Timeout, ошибка импорта и синтаксиса по-прежнему не принимаются за обнаружение.
- Обновлён `tests/evidence/mutations.md`; multiline assertion сохраняет строку с точным нарушенным model-ожиданием.

## R1-02 — независимый watchdog процесса и его детей

- `npm test` вызывает `scripts/run-tests.mjs`. Он запускает прежний набор как `node --test` с теми же файлами `tests/*.test.mjs`; раскрытие списка файлов выполняется встроенным `readdir`.
- Wrapper не импортирует workflow и не исполняет его в своём event loop. Отдельный parent ставит общий предел 10 секунд. По истечении он печатает diagnostic, убивает Node runner и его descendants и возвращает exit 124. Успех и обычное падение передают исходный exit code.
- На macOS/Linux Node runner создаётся лидером detached process group; `SIGKILL` посылается всей группе, включая изолированные Node test workers и их детей. Для Windows добавлен `taskkill /T /F` с диагностикой ошибки завершения дерева; эта ветка локально не запускалась.
- Вложенный запуск wrapper из regression test очищает у своего нового runner `NODE_TEST_CONTEXT`. Иначе Node считает его рекурсивным тестовым запуском и пропускает fixtures. При первоначальном прогоне этот случай был замечен тестами и исправлен до итоговых результатов.
- `tests/workflow-watchdog.test.mjs` проверяет exit 0 и exit 1 с настоящим assertion failure, а затем запускает контролируемый `tests/fixtures/watchdog-sync-hang.mjs` через тот же wrapper. Настоящий harness исполняет `while (true) {}`: внутренние 25 ms harness и 50 ms node:test не могут завершить синхронную блокировку. Независимый wrapper с пределом 500 ms возвращает 124 и diagnostic.
- Fixture выполняется в Node test worker и запускает отдельного grandchild с heartbeat. Тест подтверждает, что heartbeat действительно начался, а после watchdog его файл больше не меняется. У grandchild есть резервный ограниченный срок жизни; cleanup также завершает известную группу/детей на случай поломки watchdog.
- У самого controlled запуска есть дополнительный независимый `spawnSync` предел 3500 ms. Срабатывание этого предела считается падением regression test, а не успехом watchdog. Fixture не входит в обычный glob и требует специальную temporary-directory переменную окружения.
- README описывает wrapper, предел, exit 124, дочерние процессы, адресный запуск и границу защиты. Прямой `node --test` bypasses wrapper; это явно указано. Защита не изображает production timeout или sandbox.

## Выполненные проверки

Локальная среда: Node v24.1.0, npm 11.7.0, macOS. Все команды завершились с exit 0:

| Команда | Результат |
| --- | --- |
| `npm test` | 389 passed, 0 failed; около 1.09 секунды в итоговом прогоне |
| `npm run test:explore` | 32 configurations, 2746 completedScenarios, 0 truncatedBranches |
| `npm run test:mutations` | 13/13 semantic mutations обнаружены ожидаемыми assertions, включая worker/verifier model omission |
| `git diff --check` | passed |

Логи итоговых прогонов: `/private/tmp/manjerok-fixes-r1-tests.log`, `/private/tmp/manjerok-fixes-r1-explore.log`, `/private/tmp/manjerok-fixes-r1-mutations.log`. Постоянное mutation evidence находится в `tests/evidence/mutations.md`; exploration evidence обновлено в `tests/evidence/exploration.json`.

## Оставшиеся ограничения

Минимальная Node 22.19.0 и Windows-ветка watchdog в этом исправлении не проверялись. Watchdog ограничивает весь test runner, а не время отдельного процесса, который намеренно создаёт новую process group/выходит из дерева. Работа Windows `taskkill` зависит от его успешного исполнения; при ошибке wrapper сообщает её и завершает хотя бы главный runner. Системный process inventory не читался: проверка descendants использует контролируемую активность grandchild, а не утверждение об отсутствии любых других процессов. Реальные production timeout, pi-subagents sandbox и качество моделей остаются вне согласованного FSM-набора.
