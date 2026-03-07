import { ResponseFormatter } from '../ui/ResponseFormatter.js';
import { AgentRegistry } from '../core/AgentRegistry.js';
import { HumanInLoopUI } from './HumanInLoopUI.js';
import { SkillManager } from '../skills/index.js';
import { UninstallManager } from '../management/index.js';
import { CheckpointDetector } from '../core/CheckpointDetector.js';
import { HookIntegration } from '../core/HookIntegration.js';
import { MCPToolInterface } from '../core/MCPToolInterface.js';
import { KnowledgeGraph } from '../knowledge-graph/index.js';
import { ProjectMemoryManager } from '../memory/ProjectMemoryManager.js';
import { ProjectAutoTracker } from '../memory/ProjectAutoTracker.js';
import { UnifiedMemoryStore } from '../memory/UnifiedMemoryStore.js';
import { SessionMemoryPipeline } from '../integrations/session-memory/index.js';
import { RateLimiter } from '../utils/RateLimiter.js';
import { ToolHandlers, BuddyHandlers } from './handlers/index.js';
import { SamplingClient } from './SamplingClient.js';
import { logger } from '../utils/logger.js';
import { logError } from '../utils/errorHandler.js';
import { checkBetterSqlite3Availability } from '../db/adapters/BetterSqlite3Adapter.js';
import { isCloudEnabled } from '../cloud/MeMeshCloudClient.js';
import { ConfigurationError } from '../errors/index.js';
export class ServerInitializer {
    static async initialize() {
        let knowledgeGraph;
        try {
            const formatter = new ResponseFormatter();
            const agentRegistry = new AgentRegistry();
            const ui = new HumanInLoopUI();
            const skillManager = new SkillManager();
            const uninstallManager = new UninstallManager(skillManager);
            const checkpointDetector = new CheckpointDetector();
            const toolInterface = new MCPToolInterface();
            const sqliteAvailability = await checkBetterSqlite3Availability();
            const cloudEnabled = isCloudEnabled();
            const cloudOnlyMode = !sqliteAvailability.available && cloudEnabled;
            logger.info('[ServerInitializer] Initialization mode determined', {
                sqliteAvailable: sqliteAvailability.available,
                cloudEnabled,
                cloudOnlyMode,
            });
            let projectMemoryManager;
            let unifiedMemoryStore;
            let sessionMemoryPipeline;
            if (sqliteAvailability.available) {
                logger.info('[ServerInitializer] Initializing with local SQLite storage');
                knowledgeGraph = KnowledgeGraph.createSync();
                projectMemoryManager = new ProjectMemoryManager(knowledgeGraph);
                unifiedMemoryStore = new UnifiedMemoryStore(knowledgeGraph);
                sessionMemoryPipeline = new SessionMemoryPipeline(knowledgeGraph);
                toolInterface.attachMemoryProvider({
                    createEntities: async ({ entities }) => {
                        for (const entity of entities) {
                            knowledgeGraph.createEntity({
                                name: entity.name,
                                entityType: entity.entityType,
                                observations: entity.observations,
                                metadata: entity.metadata,
                            });
                        }
                    },
                    searchNodes: async (query) => {
                        return knowledgeGraph.searchEntities({
                            namePattern: query,
                            limit: 10,
                        });
                    },
                });
            }
            else if (cloudOnlyMode) {
                logger.warn('[ServerInitializer] Running in cloud-only mode (local SQLite unavailable)');
                logger.warn(`[ServerInitializer] Reason: ${sqliteAvailability.error}`);
                logger.info(`[ServerInitializer] Suggestion: ${sqliteAvailability.fallbackSuggestion}`);
                logger.info('[ServerInitializer] Local memory tools will be disabled. Use cloud sync tools instead.');
                knowledgeGraph = undefined;
            }
            else {
                const errorMsg = `Cannot start MCP server: better-sqlite3 is unavailable and no cloud API key is configured.\n\n` +
                    `SQLite Error: ${sqliteAvailability.error}\n` +
                    `Suggestion: ${sqliteAvailability.fallbackSuggestion || 'Install better-sqlite3'}\n\n` +
                    `OR configure cloud-only mode:\n` +
                    `  Set MEMESH_API_KEY to use cloud storage instead of local SQLite.\n` +
                    `  Get your API key at: https://memesh.ai`;
                logger.error('[ServerInitializer] Cannot start - no storage available', {
                    sqliteError: sqliteAvailability.error,
                    cloudEnabled: false,
                });
                throw new ConfigurationError(errorMsg, {
                    component: 'ServerInitializer',
                    method: 'initialize',
                    sqliteAvailable: false,
                    cloudEnabled: false,
                    sqliteError: sqliteAvailability.error,
                    suggestion: sqliteAvailability.fallbackSuggestion,
                });
            }
            const projectAutoTracker = new ProjectAutoTracker(toolInterface);
            const hookIntegration = new HookIntegration(checkpointDetector, projectAutoTracker);
            const rateLimiter = new RateLimiter({
                requestsPerMinute: 30,
            });
            const samplingClient = new SamplingClient(async (_request) => {
                throw new Error('Sampling not yet connected. This will be wired when MCP SDK sampling is available.');
            });
            const toolHandlers = new ToolHandlers(skillManager, uninstallManager, checkpointDetector, hookIntegration, projectMemoryManager, knowledgeGraph, ui, samplingClient, unifiedMemoryStore);
            const buddyHandlers = new BuddyHandlers(formatter, projectMemoryManager, projectAutoTracker, knowledgeGraph);
            return {
                formatter,
                agentRegistry,
                ui,
                skillManager,
                uninstallManager,
                checkpointDetector,
                hookIntegration,
                toolInterface,
                knowledgeGraph,
                projectMemoryManager,
                projectAutoTracker,
                unifiedMemoryStore,
                sessionMemoryPipeline,
                cloudOnlyMode,
                rateLimiter,
                samplingClient,
                toolHandlers,
                buddyHandlers,
            };
        }
        catch (error) {
            logger.error('Initialization failed, cleaning up resources...');
            if (knowledgeGraph) {
                try {
                    await knowledgeGraph.close();
                    logger.info('KnowledgeGraph cleaned up');
                }
                catch (cleanupError) {
                    logger.error('Failed to clean up KnowledgeGraph:', cleanupError);
                }
            }
            logError(error, {
                component: 'ServerInitializer',
                method: 'initialize',
                operation: 'server initialization',
            });
            throw error;
        }
    }
}
//# sourceMappingURL=ServerInitializer.js.map