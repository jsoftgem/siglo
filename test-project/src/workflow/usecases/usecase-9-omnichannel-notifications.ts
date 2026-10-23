import { Step, flow } from 'fluid-func';

export type NotificationChannel = 'PUSH' | 'SMS' | 'EMAIL';

export interface CampaignNotificationInput {
    campaignId: string;
    userId: string;
    recipientEmail: string;
    recipientPhone: string;
    templateKey: string;
    templateVariables: Record<string, string>;
    fallbackChannels: NotificationChannel[];
}

/**
 * Use Case 9: Multi-Channel Notification & Marketing Campaign Dispatch
 * Flow: triggerCampaign -> resolveUserPreferences -> renderTemplate -> routeToChannel -> trackEngagement
 * Features:
 * - Dynamic routing slip per recipient preferences
 * - Localized gateway retry with onFail backoff
 * - Automated channel failover (e.g., fallback from PUSH to SMS/EMAIL on rate limits)
 */
export function createOmnichannelNotificationPipeline() {
    let pushAttempts = 0;

    // Step 1: Trigger Campaign
    const triggerCampaign = Step.create('notifyTriggerCampaign', async (param: any) => {
        const campaignId = param.campaignId.val;
        const userId = param.userId.val;

        return {
            campaignTriggered: true,
            dispatchId: `DISPATCH-${campaignId}-${userId}`,
            triggeredAt: Date.now()
        };
    }).spec('campaignId', { require: true })
      .spec('userId', { require: true })
      .spec('templateKey', { require: true });

    // Step 2: Resolve User Preferences & Channel Priority
    const resolveUserPreferences = Step.create('notifyResolvePreferences', async (param: any) => {
        const fallbackChannels: NotificationChannel[] = param.fallbackChannels.val || ['EMAIL'];

        // User preference: default PUSH, with fallbacks specified in input
        const selectedChannel: NotificationChannel = fallbackChannels[0] || 'EMAIL';

        return {
            optedIn: true,
            primaryChannel: selectedChannel,
            availableFallbacks: fallbackChannels.slice(1)
        };
    });

    // Step 3: Render Template
    const renderTemplate = Step.create('notifyRenderTemplate', async (param: any) => {
        const templateKey = param.templateKey.val;
        const vars: Record<string, string> = param.templateVariables.val || {};

        let body = `Hello ${vars.name || 'Valued Customer'}, here is your update.`;
        if (templateKey === 'PROMO_FLASH_SALE') {
            body = `🔥 Flash Sale! Use code ${vars.promoCode || 'SAVE20'} for 20% off today only!`;
        }

        return {
            renderedSubject: 'Special Offer Just For You',
            renderedBody: body,
            characterCount: body.length
        };
    });

    // Step 4: Route to Channel & Dispatch (with onFail retries for external SMS/Push gateways)
    const routeToChannel = Step.create('notifyRouteToChannel', async (param: any) => {
        const primaryChannel = param.primaryChannel.val;
        const body = param.renderedBody.val;
        const phone = param.recipientPhone.val;
        const email = param.recipientEmail.val;

        pushAttempts++;
        // Demonstrate handling transient rate limiting (HTTP 429) on first attempt
        if (primaryChannel === 'PUSH' && pushAttempts === 1) {
            throw new Error('APNs / FCM Gateway rate limited (HTTP 429 Too Many Requests)');
        }

        const gatewayMessageId = `GW-${primaryChannel}-${Date.now()}`;

        return {
            channelDispatched: primaryChannel,
            gatewayMessageId,
            destinationTarget: primaryChannel === 'EMAIL' ? email : phone,
            deliveryStatus: 'SENT'
        };
    }).onFail({
        retries: 2,
        delay: 10,
        backoff: 1.5
    });

    // Step 5: Track Engagement
    const trackEngagement = Step.create('notifyTrackEngagement', async (param: any) => {
        const dispatchId = param.dispatchId.val;
        const channel = param.channelDispatched.val;
        const gatewayMessageId = param.gatewayMessageId.val;
        const campaignTriggered = param.campaignTriggered.val;
        const optedIn = param.optedIn.val;
        const renderedBody = param.renderedBody.val;
        const deliveryStatus = param.deliveryStatus.val;

        const trackingPixelUrl = `https://track.notifications.io/pixel/${dispatchId}.gif`;

        return {
            notificationPipelineStatus: 'DELIVERED',
            campaignTriggered,
            optedIn,
            renderedBody,
            deliveryStatus,
            dispatchId,
            channel,
            gatewayMessageId,
            trackingPixelUrl,
            sentAt: new Date().toISOString()
        };
    });

    return flow(
        triggerCampaign,
        resolveUserPreferences,
        renderTemplate,
        routeToChannel,
        trackEngagement
    );
}
