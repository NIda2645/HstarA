(function(){
    const PROTOCOL_VERSION = 1;
    const SCENE_PREFIX = 'director:';
    const TYPES = Object.freeze({
        READY: 'storyai:director-desk-ready',
        CLOSE: 'storyai:director-desk-close',
        SESSION: 'storyai:director-desk-session',
        PANORAMA: 'storyai:director-desk-panorama',
        PANORAMA_REMOVED: 'storyai:director-desk-panorama-removed',
        CAPTURES_SENT: 'storyai:director-desk-captures-sent',
        PICK_TARGET: 'storyai:director-desk-pick-target',
        IMPORT_RESULT: 'storyai:director-desk-import-result',
        ERROR: 'storyai:director-desk-error',
        RENDER_STATE: 'storyai:director-desk-render-state'
    });

    function cleanKeyPart(value){
        return String(value || '').trim();
    }

    function createSceneKey(canvasType, canvasId, nodeId){
        return `${SCENE_PREFIX}${cleanKeyPart(canvasType)}:${cleanKeyPart(canvasId)}:${cleanKeyPart(nodeId)}`;
    }

    function createStandaloneSceneKey(){
        return `${SCENE_PREFIX}standalone`;
    }

    function createEnvelope({type, sessionId, requestId, context, payload}){
        return {
            type,
            protocolVersion: PROTOCOL_VERSION,
            sessionId,
            requestId,
            context,
            payload: payload || {}
        };
    }

    function validateEnvelope(value){
        if(!value || typeof value !== 'object') return {ok:false, reason:'not-object'};
        if(value.protocolVersion !== PROTOCOL_VERSION) return {ok:false, reason:'version'};
        if(typeof value.type !== 'string' || !value.type.startsWith('storyai:director-desk-')){
            return {ok:false, reason:'type'};
        }
        if(typeof value.sessionId !== 'string' || !value.sessionId) return {ok:false, reason:'session'};
        if(typeof value.requestId !== 'string' || !value.requestId) return {ok:false, reason:'request'};
        if(!value.context || typeof value.context !== 'object') return {ok:false, reason:'context'};
        return {ok:true};
    }

    window.HstarDirectorProtocol = Object.freeze({
        PROTOCOL_VERSION,
        SCENE_PREFIX,
        TYPES,
        createSceneKey,
        createStandaloneSceneKey,
        createEnvelope,
        validateEnvelope
    });
})();
