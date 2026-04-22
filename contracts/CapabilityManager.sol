// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import "./Verifier.sol";
import "./BatchVerifier.sol";

contract CapabilityManager is Ownable {
    using ECDSA for bytes32;
    using MessageHashUtils for bytes32;

    Groth16Verifier public zkpVerifier;
    BatchGroth16Verifier public batchZkpVerifier;

    // ==========================================
    // 抗白嫖声誉机制
    // ==========================================
    mapping(address => uint8) public creditScore;
    event ReputationSlashed(address indexed holder, uint8 newScore);

    function getCreditScore(address holder) public view returns (uint8) {
        uint8 score = creditScore[holder];
        return score == 0 ? 100 : score;
    }

    function slashReputation(address maliciousHolder) external {
        uint8 currentScore = getCreditScore(maliciousHolder);
        require(currentScore >= 50, "Credit already ruined");

        creditScore[maliciousHolder] = currentScore - 50;
        emit ReputationSlashed(maliciousHolder, creditScore[maliciousHolder]);
    }

    // ==========================================
    // capability registry
    // ==========================================
    struct Capability {
        address issuer;
        address holder;
        uint256 perms;
        uint256 budget;
        uint256 expiry;
        bytes32 parentId;
    }

    mapping(bytes32 => Capability) public registeredCaps;
    mapping(bytes32 => bool) public isRevoked;
    mapping(bytes32 => bool) public verifiedZKPCaps;
    mapping(bytes32 => bool) public verifiedBatchRoots;

    event CapabilityRegistered(bytes32 indexed capId, address indexed holder);
    event CapabilityDelegated(bytes32 indexed parentId, bytes32 indexed childId, address indexed newHolder);
    event CapabilityVerifiedZKP(bytes32 indexed capId);
    event BatchCapabilityVerifiedZKP(bytes32 indexed batchRoot);

    event RootVerifierUpdated(address indexed newVerifier);
    event BatchVerifierUpdated(address indexed newVerifier);

    constructor(address _rootVerifier, address _batchVerifier) Ownable(msg.sender) {
        require(_rootVerifier != address(0), "Invalid root verifier");
        require(_batchVerifier != address(0), "Invalid batch verifier");

        zkpVerifier = Groth16Verifier(_rootVerifier);
        batchZkpVerifier = BatchGroth16Verifier(_batchVerifier);
    }

    function setRootVerifier(address _newRootVerifier) external onlyOwner {
        require(_newRootVerifier != address(0), "Invalid root verifier");
        zkpVerifier = Groth16Verifier(_newRootVerifier);
        emit RootVerifierUpdated(_newRootVerifier);
    }

    function setBatchVerifier(address _newBatchVerifier) external onlyOwner {
        require(_newBatchVerifier != address(0), "Invalid batch verifier");
        batchZkpVerifier = BatchGroth16Verifier(_newBatchVerifier);
        emit BatchVerifierUpdated(_newBatchVerifier);
    }

    function registerBatchZKP(
        uint256[2] calldata a,
        uint256[2][2] calldata b,
        uint256[2] calldata c,
        uint256[1] calldata input
    ) external {
        require(batchZkpVerifier.verifyProof(a, b, c, input), "BatchZKP: Invalid Math Proof!");
        bytes32 batchRoot = bytes32(input[0]);
        require(!verifiedBatchRoots[batchRoot], "BatchZKP: Root already verified");
        verifiedBatchRoots[batchRoot] = true;
        emit BatchCapabilityVerifiedZKP(batchRoot);
    }

    function registerRootZKP(
        uint256[2] calldata a,
        uint256[2][2] calldata b,
        uint256[2] calldata c,
        uint256[1] calldata input
    ) external {
        require(zkpVerifier.verifyProof(a, b, c, input), "ZKP: Invalid Math Proof!");
        bytes32 capId = bytes32(input[0]);
        require(!verifiedZKPCaps[capId], "ZKP: Capability already verified");
        verifiedZKPCaps[capId] = true;
        emit CapabilityVerifiedZKP(capId);
    }

    function registerRoot(
        bytes32 capId,
        address issuer,
        address holder,
        uint256 perms,
        uint256 budget,
        uint256 expiry,
        bytes memory signature
    ) external {
        require(registeredCaps[capId].holder == address(0), "Capability already exists");
        require(expiry > block.timestamp, "Already expired");

        bytes32 messageHash = keccak256(abi.encodePacked(issuer, holder, perms, budget, expiry, bytes32(0)));
        bytes32 ethSignedMessageHash = messageHash.toEthSignedMessageHash();
        require(ethSignedMessageHash.recover(signature) == issuer, "Invalid issuer signature");

        registeredCaps[capId] = Capability(issuer, holder, perms, budget, expiry, bytes32(0));
        emit CapabilityRegistered(capId, holder);
    }

    function registerDelegation(
        bytes32 childId,
        bytes32 parentId,
        address newHolder,
        uint256 newPerms,
        uint256 newBudget,
        uint256 newExpiry,
        bytes memory signature
    ) external {
        Capability memory parent = registeredCaps[parentId];
        require(parent.holder != address(0), "Parent capability not found");
        require(!isRevoked[parentId], "Parent capability is revoked");

        require((newPerms & parent.perms) == newPerms, "Weakening violation: perms");
        require(newBudget <= parent.budget, "Weakening violation: budget");
        require(newExpiry <= parent.expiry, "Weakening violation: expiry");

        bytes32 messageHash = keccak256(
            abi.encodePacked(newHolder, newPerms, newBudget, newExpiry, parentId)
        );
        bytes32 ethSignedMessageHash = messageHash.toEthSignedMessageHash();

        require(ethSignedMessageHash.recover(signature) == parent.holder, "Invalid delegator signature");

        registeredCaps[childId] = Capability(parent.issuer, newHolder, newPerms, newBudget, newExpiry, parentId);
        emit CapabilityDelegated(parentId, childId, newHolder);
    }
}