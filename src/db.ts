import { createClient } from '@supabase/supabase-js';

/**
 * Initialize Supabase client using environment variables
 */
const getSupabaseClient = (env: any) => {
    return createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY);
};

/**
 * Fetch the user's tier from the 'api_keys' table
 * Returns 'FREE' as a fallback if the key is invalid or an error occurs
 */
export const fetchUserTier = async (apiKey: string, env: any): Promise<string> => {
    const supabase = getSupabaseClient(env);

    // Querying the 'api_keys' table to match the provided key
    const { data, error } = await supabase
        .from('api_keys')
        .select('tier')
        .eq('key', apiKey)
        .single();

    if (error) {
        // Log database error for internal debugging
        console.error('Supabase query error:', error.message);
        return 'FREE';
    }

    // Ensure the tier matches the expected configuration (FREE, STARTER, PRO, SCALE)
    return data?.tier?.toUpperCase() || 'FREE';
};
