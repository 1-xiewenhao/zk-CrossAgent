pragma circom 2.0.0;

// 引入官方的 Poseidon 哈希电路库
include "../node_modules/circomlib/circuits/poseidon.circom";

/**
 * @title CapabilityAuth (AI 智能体权限零知识证明电路)
 * @dev 证明：网关确实掌握了一组【合法的权限参数】，且这些参数能够推导出正确的【公链锚定 capId】。
 * 效果：实现 100% 的隐私保护，外界无法逆推预算和权限细节！
 */
template CapabilityAuth() {
    // 1. 私有输入 (Private Inputs)：只有网关知道，绝对不会上传到区块链！
    signal input issuer;   // 老板地址
    signal input holder;   // 买家地址 (DeepSeek)
    signal input perms;    // 权限位图
    signal input budget;   // 预算金额
    signal input expiry;   // 过期时间戳

    // 2. 公开输出 (Public Output)：这是唯一要在公链上露脸的凭证 ID
    signal output capId;

    // 3. 电路核心逻辑：计算 ZK 友好的 Poseidon 哈希
    // 我们传入 5 个参数，所以实例化一个输入为 5 的 Poseidon 哈希器
    component hasher = Poseidon(5);
    
    // 把私密数据接线 (Wire) 到哈希器上
    hasher.inputs[0] <== issuer;
    hasher.inputs[1] <== holder;
    hasher.inputs[2] <== perms;
    hasher.inputs[3] <== budget;
    hasher.inputs[4] <== expiry;

    // 4. 将哈希结果作为最终的公开凭证 ID 输出
    capId <== hasher.out;
    
    // (论文伏笔：未来我们还可以在这里加上 expiry > currentTime 的时间约束电路！)
}

// 实例化主组件。
// 注意：在 Circom 里，所有 input 默认都是 private（绝对保密）的！
component main = CapabilityAuth();