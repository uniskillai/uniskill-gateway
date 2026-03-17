// src/routes/uniskill-smart-chart.ts
// Logic: A headless rendering engine that converts structured JSON data into high-quality chart image URLs.

/**
 * Logic: Smart Chart Generator Engine using QuickChart.io
 * 逻辑：基于 QuickChart.io 的智能图表生成引擎
 */
export async function executeSmartChart(params: any, _env: any) {
    try {
        // 1. 提取并校验 Agent 传入的核心数据参数
        // 确保输入包含必须的 labels (X轴) 和 datasets (Y轴数据)
        const chartType = params.chartType || 'bar';
        const title = params.title || '';
        const labels = params.labels || [];
        const datasets = params.datasets || [];
        const isDarkMode = params.theme === 'dark';

        if (!labels.length || !datasets.length) {
            throw new Error("Missing required data parameters: 'labels' and 'datasets' cannot be empty.");
        }

        // 2. 构建 Chart.js 兼容的基础配置对象
        // 这里定义了图表的外观、类型和数据集映射关系
        const chartConfig: any = {
            type: chartType,
            data: {
                labels: labels,
                datasets: datasets
            },
            options: {
                plugins: {
                    title: {
                        display: !!title,
                        text: title,
                        color: isDarkMode ? '#ffffff' : '#666666',
                        font: { size: 20 }
                    },
                    legend: {
                        labels: {
                            color: isDarkMode ? '#dddddd' : '#666666'
                        }
                    }
                }
            }
        };

        // 3. 针对暗黑模式 (Dark Mode) 的特殊底色处理
        // 如果是深色主题，为整个图表背景填充颜色，避免透明 PNG 在暗色聊天框中看不清
        if (isDarkMode) {
            chartConfig.options.plugins.chartArea = {
                backgroundColor: '#1e1e1e'
            };
            chartConfig.options.scales = {
                x: { ticks: { color: '#aaaaaa' }, grid: { color: '#333333' } },
                y: { ticks: { color: '#aaaaaa' }, grid: { color: '#333333' } }
            };
        }

        // 4. 将庞大的 JSON 配置序列化，并进行 URL 安全编码
        // 准备拼接给第三方无头渲染引擎 (QuickChart)
        const encodedConfig = encodeURIComponent(JSON.stringify(chartConfig));
        
        // 5. 拼接最终的公开调用 URL，设置高清分辨率 (devicePixelRatio=2.0) 和背景色
        const backgroundColor = isDarkMode ? '1e1e1e' : 'ffffff';
        const chartUrl = `https://quickchart.io/chart?c=${encodedConfig}&width=800&height=400&devicePixelRatio=2.0&bkg=${backgroundColor}`;

        // 6. 返回结果给 Agent，Agent 可直接将此 imageUrl 插入飞书卡片或 Markdown
        return {
            status: "success",
            imageUrl: chartUrl,
            renderEngine: "QuickChart.io",
            metadata: {
                type: chartType,
                dataPoints: labels.length
            }
        };

    } catch (error: any) {
        return {
            status: "error",
            message: `Chart generation failed: ${error.message}`
        };
    }
}
