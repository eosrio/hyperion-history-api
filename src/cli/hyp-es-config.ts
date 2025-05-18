import {Command} from "commander";
import {Client} from "@elastic/elasticsearch";
import path from "path";
import {readFile} from "fs/promises";
import {existsSync} from "fs";
import {HyperionConnections} from "../interfaces/hyperionConnections.js";

const program = new Command();
const rootDir = path.join(import.meta.dirname, '../../');
const configDir = path.join(rootDir, 'config');
const connectionsPath = path.join(configDir, 'connections.json');

// Definição de tipo para tarefas de reindexação
interface ReindexTask {
    taskId: string | number;
    targetIndex: string;
    rangeStart: number;
    rangeEnd: number;
    partition: number;
}

// Obtém as configurações de conexão do arquivo connections.json
async function getConnections(): Promise<HyperionConnections | null> {
    if (existsSync(connectionsPath)) {
        const connectionsJsonFile = await readFile(connectionsPath);
        return JSON.parse(connectionsJsonFile.toString());
    } else {
        return null;
    }
}

// Cria um cliente Elasticsearch com base nas configurações
async function createEsClient(): Promise<Client | null> {
    const connections = await getConnections();

    if (!connections) {
        console.log(`O arquivo connections.json não foi encontrado. Execute "./hyp-config connections init" para configurá-lo.`);
        return null;
    }

    const _es = connections.elasticsearch;
    let es_url;

    if (!_es.protocol) {
        _es.protocol = 'http';
    }

    if (_es.user !== '') {
        es_url = `${_es.protocol}://${_es.user}:${_es.pass}@${_es.host}`;
    } else {
        es_url = `${_es.protocol}://${_es.host}`;
    }

    return new Client({
        node: es_url,
        tls: {
            rejectUnauthorized: false
        }
    });
}

// Função principal para particionar um índice
async function partitionIndex(indexName: string, partitionSize: number, options: any) {
    console.log(`Iniciando a partição do índice ${indexName} com tamanho ${partitionSize} blocos por partição`);

    const client = await createEsClient();
    if (!client) {
        process.exit(1);
    }

    try {
        // Verificar se o índice fonte existe
        const indexExists = await client.indices.exists({
            index: indexName
        });

        if (!indexExists) {
            console.error(`Erro: O índice ${indexName} não existe.`);
            process.exit(1);
        }

        // Assumindo que o campo block_num sempre existe, já que estamos trabalhando com tabela de blocos
        const blockField = "block_num";
        console.log(`Campo identificado para particionamento: ${blockField}`);

        // Obter os valores mínimo e máximo do campo block_num
        const stats = await getFieldStats(client, indexName, blockField);
        if (!stats) {
            console.error(`Erro: Não foi possível obter estatísticas do campo ${blockField}`);
            process.exit(1);
        }

        const {min, max, count} = stats;
        console.log(`Estatísticas do campo ${blockField}:`);
        console.log(`- Valor mínimo: ${min}`);
        console.log(`- Valor máximo: ${max}`);
        console.log(`- Total de documentos: ${count}`);

        if (count === 0) {
            console.log(`O índice ${indexName} está vazio. Não há documentos para reindexar.`);
            process.exit(0);
        }

        // Calcular as partições baseadas no range de block_num
        const numPartitions = Math.ceil(count / partitionSize);

        console.log(`Criando... ${numPartitions} partições com ${partitionSize} blocos cada`);

        // Iniciar as tarefas de reindexação para cada partição
        const tasks: ReindexTask[] = [];

        // Calcular o numero da particao inicial
        const startPartition = Math.floor(min / partitionSize);
        const lastPartition = Math.floor(max / partitionSize);

        console.log(`Partição inicial: ${startPartition}`);


        for (let i = startPartition; i < lastPartition; i++) {
            const partitionNumber = i + 1;
            const paddedNumber = String(partitionNumber).padStart(6, '0');
            const targetIndex = `${indexName}-${paddedNumber}`;

            const rangeStart = i * partitionSize;
            const rangeEnd = rangeStart + partitionSize - 1;

            // Verificar se o índice destino já existe
            const targetExists = await client.indices.exists({index: targetIndex});
            if (targetExists) {
                if (options.force) {
                    await client.indices.delete({index: targetIndex});
                    console.log(`Índice ${targetIndex} excluído para recriação`);
                } else {
                    console.error(`Erro: O índice ${targetIndex} já existe. Use --force para substituí-lo.`);
                    process.exit(1);
                }
            }

            console.log(`\nIniciando reindexação para ${targetIndex}`);
            console.log(`Intervalo de ${blockField}: ${rangeStart} até ${rangeEnd}`);

            const reindexBody = {
                source: {
                    index: indexName,
                    query: {
                        range: {
                            [blockField]: {
                                gte: rangeStart,
                                lte: rangeEnd
                            }
                        }
                    }
                },
                dest: {
                    index: targetIndex
                }
            };

            try {
                // Iniciar a tarefa de reindexação
                const response = await client.reindex({
                    ...reindexBody,
                    wait_for_completion: false,
                    refresh: true
                });

                console

                const taskId = response.task;

                if (!taskId) {
                    console.error(`Erro: Não foi possível obter o ID da tarefa de reindexação.`);
                    process.exit(1);
                }
                tasks.push({
                    taskId,
                    targetIndex,
                    rangeStart,
                    rangeEnd,
                    partition: partitionNumber
                });

                console.log(`✓ Tarefa de reindexação iniciada: ${taskId}`);
            } catch (error: any) {
                console.error(`Erro ao iniciar reindexação para ${targetIndex}: ${error.message}`);

                if (!options.continueOnError) {
                    process.exit(1);
                }
            }
        }

        console.log(`\n${tasks.length} tarefas de reindexação iniciadas`);

        // Exibir as tarefas iniciadas
        console.log("\nTarefas de reindexação:");
        console.log("-----------------------------------------");
        tasks.forEach(task => {
            console.log(`Partição ${task.partition}/${numPartitions}: ${task.targetIndex}`);
            console.log(`  Task ID: ${task.taskId}`);
            console.log(`  Intervalo: ${task.rangeStart} a ${task.rangeEnd}`);
            console.log("-----------------------------------------");
        });

        console.log("\nAs tarefas estão sendo executadas em segundo plano.");
        console.log("Para verificar o status, execute:");
        console.log("  ./hyp-es-config tasks");

    } catch (error: any) {
        console.error(`Erro: ${error.message}`);
        process.exit(1);
    }
}


// Obtém estatísticas (min, max, count) de um campo numérico
async function getFieldStats(client: Client, indexName: string, fieldName: string) {
    try {
        const response = await client.search({
            index: indexName,
            size: 0,
            aggs: {
                min_value: {min: {field: fieldName}},
                max_value: {max: {field: fieldName}}
            }
        });

        const countResponse = await client.count({
            index: indexName
        });

        // Acesso às agregações com tipagem segura
        const minValue = response.aggregations &&
        typeof response.aggregations === 'object' &&
        response.aggregations.min_value &&
        'value' in response.aggregations.min_value ?
            response.aggregations.min_value.value : 0;

        const maxValue = response.aggregations &&
        typeof response.aggregations === 'object' &&
        response.aggregations.max_value &&
        'value' in response.aggregations.max_value ?
            response.aggregations.max_value.value : 0;

        return {
            min: Math.floor(minValue as number),
            max: Math.ceil(maxValue as number),
            count: countResponse.count
        };
    } catch (error) {
        console.error(`Erro ao obter estatísticas: ${error}`);
        return null;
    }
}

// Lista os índices disponíveis
async function listIndices() {
    const client = await createEsClient();
    if (!client) {
        process.exit(1);
    }

    try {
        const indices = await client.cat.indices({format: "json"});

        console.log("\nÍndices disponíveis:");
        console.log("------------------------------------------------------------------");
        console.log("Índice                          | Documentos |   Tamanho   | Estado");
        console.log("------------------------------------------------------------------");

        indices.forEach((index: any) => {
            if (index && index.index) {
                const indexName = index.index.toString().padEnd(30);
                const docsCount = (index.docsCount || index["docs.count"] || "0").padEnd(10);
                const size = (index["pri.store.size"] || index.priStoreSize || "0").padEnd(11);
                const health = index.health || "?";

                console.log(`${indexName} | ${docsCount} | ${size} | ${health}`);
            }
        });

    } catch (error: any) {
        console.error(`Erro ao listar índices: ${error.message}`);
        process.exit(1);
    }
}

// Lista e monitora as tarefas do Elasticsearch
async function listTasks(options: any) {
    const client = await createEsClient();
    if (!client) {
        process.exit(1);
    }

    try {
        // Obter todas as tarefas ativas no Elasticsearch
        const tasksResponse = await client.tasks.list({
            detailed: true,
            actions: "*reindex*"
        });

        const tasks = tasksResponse.nodes ?
            Object.entries(tasksResponse.nodes).flatMap(([nodeId, nodeInfo]: [string, any]) =>
                nodeInfo.tasks ?
                    Object.entries(nodeInfo.tasks).map(([taskId, taskInfo]: [string, any]) => ({
                        fullTaskId: `${nodeId}:${taskId}`,
                        nodeId,
                        taskId,
                        action: taskInfo.action,
                        status: taskInfo.status,
                        running_time_ns: taskInfo.running_time_in_nanos,
                        running_time: Math.floor(taskInfo.running_time_in_nanos / 1000000) + 'ms',
                        description: taskInfo.description
                    })) :
                    []
            ) :
            [];

        if (tasks.length === 0) {
            console.log("\nNenhuma tarefa de reindexação em execução no momento.");
            return;
        }

        console.log("\nTarefas de reindexação ativas:");
        console.log("------------------------------------------------------------------");
        console.log("ID da Tarefa                      | Ação      | Tempo Executando  | Descrição");
        console.log("------------------------------------------------------------------");

        tasks.forEach(task => {
            const taskIdFormatted = task.fullTaskId.padEnd(30);
            const action = (task.action || "").padEnd(10);
            const runningTime = (task.running_time || "").padEnd(17);

            console.log(`${taskIdFormatted} | ${action} | ${runningTime} | ${task.description || ""}`);
        });


    } catch (error: any) {
        console.error(`Erro ao listar tarefas: ${error.message}`);
        if (error.meta && error.meta.body) {
            console.error(JSON.stringify(error.meta.body, null, 2));
        }
        process.exit(1);
    }
}

// Criando os comandos CLI
(() => {
    program
        .version("1.0.0")
        .description("Ferramenta para gerenciar índices do Elasticsearch para o Hyperion");

    // Comando para listar índices
    program
        .command("list")
        .alias("ls")
        .description("Listar todos os índices do Elasticsearch")
        .action(listIndices);

    // Comando para listar tarefas
    program
        .command("tasks")
        .description("Listar e monitorar tarefas de reindexação ativas")
        .action(listTasks);

    // Comando para particionar um índice
    program
        .command("reindex <index_name> <partition_size>")
        .description("Reindexar um índice em partições numeradas (ex: index-000001)")
        .option("--force", "Forçar operação mesmo se os índices de destino já existirem")
        .action((indexName, partitionSize, options) => {
            const size = parseInt(partitionSize, 10);
            if (isNaN(size) || size <= 0) {
                console.error("Erro: O tamanho da partição deve ser um número positivo");
                process.exit(1);
            }
            partitionIndex(indexName, size, options);
        });

    program.parse(process.argv);
})();
