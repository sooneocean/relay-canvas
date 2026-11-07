import { replayGraphBenchmark } from '../server/graph-benchmark.js';
import { GRAPH_BENCHMARK_V1 } from '../tests/fixtures/graph-benchmark-v01.js';

const report = replayGraphBenchmark(GRAPH_BENCHMARK_V1);
console.log(JSON.stringify(report, null, 2));
if (report.failed > 0) process.exitCode = 1;
