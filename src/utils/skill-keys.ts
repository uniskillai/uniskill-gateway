// src/utils/skill-keys.ts
// Logic: Centralized key management for the three-tier storage hierarchy
// 逻辑：三层存储架构的中心化 Key 管理

export const SkillKeys = {
    // Logic: Official skills remain global
    // 逻辑：官方技能保持全局统一
    official: (name: string) => `skill:official:${name}`,

    /**
     * Logic: Private skills now indexed by user_uid for stability across key resets
     * 逻辑：私有技能现在通过 user_uid 进行索引，确保 Key 重置后数据不丢失
     */
    private: (uid: string, name: string) => `skill:private:${uid}:${name}`,

    /**
     * Logic: Marketplace skills are public but carry author attribution
     * 逻辑：市场技能公开可见，但带有作者归属标签
     */
    market: (name: string) => `skill:market:${name}`,

    /**
     * Logic: User-specific API keys (Secrets) for private tools
     * 逻辑：用户私有的 API 密钥（Secrets），用于私有工具调用
     */
    secrets: (uid: string) => `user:secrets:${uid}`,

    /**
     * Logic: Skill-specific API keys (Secrets)
     * 逻辑：技能专属的 API 密钥（Secrets），对应 skills 表的 secrets 字段
     */
    skillSecrets: (uid: string, name: string) => `skill:secrets:${uid}:${name}`,

    // Logic: Unified user profile storage (Credits + Tier)
    // 逻辑：统一的用户信息存储（包含积分和等级）
    profile: (uid: string) => `user:profile:${uid}`,

    // LEGACY: Old separate credit storage
    // 废弃：旧的独立积分存储
    credits: (uid: string) => `user:credits:${uid}`,

    /**
     * LEGACY: Old separate tier storage
     * 废弃：旧的独立等级存储
     */
    tier: (uid: string) => `tier:${uid}`,

    /**
     * Logic: Stable user UID mapping indexed by key_hash
     * 逻辑：稳定的用户 UID 映射关系，以 key_hash 索引
     */
    authHash: (keyHash: string) => `auth:hash:${keyHash}`,

    /**
     * LEGACY: Old user UID mapping format
     * 废弃：旧版用户 UID 映射格式
     */
    userUid: (keyHash: string) => `user:uid:${keyHash}`,

    /**
     * Logic: Helper to identify the storage type from a raw KV key
     * 逻辑：辅助函数，从原始 KV Key 中识别存储类型
     */
    getCategory: (key: string): 'official' | 'private' | 'market' | 'unknown' => {
        if (key.startsWith('skill:official:')) return 'official';
        if (key.startsWith('skill:private:')) return 'private';
        if (key.startsWith('skill:market:')) return 'market';
        return 'unknown';
    }
};
