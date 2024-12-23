import {
    composeContext,
    generateMessageResponse,
    generateShouldRespond,
    Memory,
    ModelClass,
    stringToUuid,
    lunaLogger,
    HandlerCallback,
    Content,
    type IAgentRuntime,
} from "@luna/core";
import type { FarcasterClient } from "./client";
import { toHex } from "viem";
import { buildConversationThread, createCastMemory } from "./memory";
import { Cast, Profile } from "./types";
import {
    formatCast,
    formatTimeline,
    messageHandlerTemplate,
    shouldRespondTemplate,
} from "./prompts";
import { castUuid } from "./utils";
import { sendCast } from "./actions";

export class FarcasterInteractionManager {
    private timeout: NodeJS.Timeout | undefined;
    constructor(
        public client: FarcasterClient,
        public runtime: IAgentRuntime,
        private signerUuid: string,
        public cache: Map<string, any>
    ) {}

    public async start() {
        const handleInteractionsLoop = async () => {
            try {
                await this.handleInteractions();
            } catch (error) {
                lunaLogger.error(error);
                return;
            }

            this.timeout = setTimeout(
                handleInteractionsLoop,
                Number(
                    this.runtime.getSetting("FARCASTER_POLL_INTERVAL") || 120
                ) * 1000 // Default to 2 minutes
            );
        };

        handleInteractionsLoop();
    }

    public async stop() {
        if (this.timeout) clearTimeout(this.timeout);
    }

    private async handleInteractions() {
        const agentFid = Number(this.runtime.getSetting("FARCASTER_FID"));

        const mentions = await this.client.getMentions({
            fid: agentFid,
            pageSize: 10,
        });

        const agent = await this.client.getProfile(agentFid);
        for (const mention of mentions) {
            const messageHash = toHex(mention.hash);
            const conversationId = `${messageHash}-${this.runtime.agentId}`;
            const roomId = stringToUuid(conversationId);
            const userId = stringToUuid(mention.authorFid.toString());

            const pastMemoryId = castUuid({
                agentId: this.runtime.agentId,
                hash: mention.hash,
            });

            const pastMemory =
                await this.runtime.messageManager.getMemoryById(pastMemoryId);

            if (pastMemory) {
                continue;
            }

            await this.runtime.ensureConnection(
                userId,
                roomId,
                mention.profile.username,
                mention.profile.name,
                "farcaster"
            );

            const thread = await buildConversationThread({
                client: this.client,
                runtime: this.runtime,
                cast: mention,
            });

            const memory: Memory = {
                content: { text: mention.text, hash: mention.hash },
                agentId: this.runtime.agentId,
                userId,
                roomId,
            };

            await this.handleCast({
                agent,
                cast: mention,
                memory,
                thread,
            });
        }

        this.client.lastInteractionTimestamp = new Date();
    }

    private async handleCast({
        agent,
        cast,
        memory,
        thread,
    }: {
        agent: Profile;
        cast: Cast;
        memory: Memory;
        thread: Cast[];
    }) {
        if (cast.profile.fid === agent.fid) {
            lunaLogger.info("skipping cast from bot itself", cast.hash);
            return;
        }

        if (!memory.content.text) {
            lunaLogger.info("skipping cast with no text", cast.hash);
            return { text: "", action: "IGNORE" };
        }

        const currentPost = formatCast(cast);

        const { timeline } = await this.client.getTimeline({
            fid: agent.fid,
            pageSize: 10,
        });

        const formattedTimeline = formatTimeline(
            this.runtime.character,
            timeline
        );

        const formattedConversation = thread
            .map(
                (cast) => `@${cast.profile.username} (${new Date(
                    cast.timestamp
                ).toLocaleString("en-US", {
                    hour: "2-digit",
                    minute: "2-digit",
                    month: "short",
                    day: "numeric",
                })}):
                ${cast.text}`
            )
            .join("\n\n");

        const state = await this.runtime.composeState(memory, {
            farcasterUsername: agent.username,
            timeline: formattedTimeline,
            currentPost,
            formattedConversation,
        });

        const shouldRespondContext = composeContext({
            state,
            template:
                this.runtime.character.templates
                    ?.farcasterShouldRespondTemplate ||
                this.runtime.character?.templates?.shouldRespondTemplate ||
                shouldRespondTemplate,
        });

        const memoryId = castUuid({
            agentId: this.runtime.agentId,
            hash: cast.hash,
        });

        const castMemory =
            await this.runtime.messageManager.getMemoryById(memoryId);

        if (!castMemory) {
            await this.runtime.messageManager.createMemory(
                createCastMemory({
                    roomId: memory.roomId,
                    runtime: this.runtime,
                    cast,
                })
            );
        }

        const shouldRespondResponse = await generateShouldRespond({
            runtime: this.runtime,
            context: shouldRespondContext,
            modelClass: ModelClass.SMALL,
        });

        if (
            shouldRespondResponse === "IGNORE" ||
            shouldRespondResponse === "STOP"
        ) {
            lunaLogger.info(
                `Not responding to cast because generated ShouldRespond was ${shouldRespondResponse}`
            );
            return;
        }

        const context = composeContext({
            state,
            template:
                this.runtime.character.templates
                    ?.farcasterMessageHandlerTemplate ??
                this.runtime.character?.templates?.messageHandlerTemplate ??
                messageHandlerTemplate,
        });

        const responseContent = await generateMessageResponse({
            runtime: this.runtime,
            context,
            modelClass: ModelClass.LARGE,
        });

        responseContent.inReplyTo = memoryId;

        if (!responseContent.text) return;

        if (this.runtime.getSetting("FARCASTER_DRY_RUN") === "true") {
            lunaLogger.info(
                `Dry run: would have responded to cast ${cast.hash} with ${responseContent.text}`
            );
            return;
        }

        const callback: HandlerCallback = async (
            content: Content,
            files: any[]
        ) => {
            try {
                if (memoryId && !content.inReplyTo) {
                    content.inReplyTo = memoryId;
                }
                const results = await sendCast({
                    runtime: this.runtime,
                    client: this.client,
                    signerUuid: this.signerUuid,
                    profile: cast.profile,
                    content: content,
                    roomId: memory.roomId,
                    inReplyTo: {
                        fid: cast.authorFid,
                        hash: cast.hash,
                    },
                });
                // sendCast lost response action, so we need to add it back here
                results[0].memory.content.action = content.action;

                for (const { memory } of results) {
                    await this.runtime.messageManager.createMemory(memory);
                }
                return results.map((result) => result.memory);
            } catch (error) {
                console.error("Error sending response cast:", error);
                return [];
            }
        };

        const responseMessages = await callback(responseContent);

        const newState = await this.runtime.updateRecentMessageState(state);

        await this.runtime.processActions(
            memory,
            responseMessages,
            newState,
            callback
        );
    }
}