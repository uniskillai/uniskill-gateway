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

    // Logic: Credit storage indexed by user_uid
    // 逻辑：积分存储以 user_uid 作为唯一主键
    credits: (uid: string) => `user:credits:${uid}`,

    /**
     * Logic: User tier information indexed by user_uid
     * 逻辑：用户档位信息，以 user_uid 索引
     */
    tier: (uid: string) => `tier:${uid}`,

    /**
     * Logic: Stable user UID mapping indexed by key_hash
     * 逻辑：稳定的用户 UID 映射关系，以 key_hash 索引
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
