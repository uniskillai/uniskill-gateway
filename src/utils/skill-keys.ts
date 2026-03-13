// src/utils/skill-keys.ts
// Logic: Centralized key management for the three-tier storage hierarchy
// 逻辑：三层存储架构的中心化 Key 管理

export const SkillKeys = {
    // Logic: Official skills remain global
    // 逻辑：官方技能保持全局统一
    official: (name: string) => `skill:official:${name}`,

    /**
     * Logic: Private skills now indexed by key_hash
     * 逻辑：私有技能现在通过 key_hash 进行索引，确保用户间数据隔离
     */
    private: (keyHash: string, name: string) => `skill:private:${keyHash}:${name}`,

    /**
     * Logic: Marketplace skills are public but carry author attribution
     * 逻辑：市场技能公开可见，但带有作者归属标签
     */
    market: (name: string) => `skill:market:${name}`,

    // Logic: Credit storage indexed by key_hash
    // 逻辑：积分存储以 key_hash 作为唯一标识
    credits: (keyHash: string) => `user:credits:${keyHash}`,

    /**
     * Logic: User tier information indexed by key_hash
     * 逻辑：用户档位信息，以 key_hash 索引
     */
    tier: (keyHash: string) => `tier:${keyHash}`,

    /**
     * Logic: Stable user UID indexed by key_hash
     * 逻辑：稳定的用户 UID，以 key_hash 索引
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
