const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

async function main() {
  const slug = "3-gusset-zipper-pouch-premium-gltf";
  
  const editorState = {
    bgColor: "#f8f9fa",
    bgType: "solid",
    showGrid: true,
    showShadow: true,
    enableFloat: true,
    keyLightIntensity: 0.85,
    fillLightIntensity: 0.45,
    rimLightIntensity: 0.35,
    ambientLightIntensity: 0.55,
    scale: 1.15,
    rotation: [0, 25, 0],
    textures: {
      front: null,
      back: null,
      left: null,
      right: null,
      top: null,
      bottom: null,
      overall: null,
      label: null
    },
    materials: {
      Front: { color: "#ffffff", roughness: 0.25, metalness: 0.05, emissive: 0 },
      Back: { color: "#ffffff", roughness: 0.25, metalness: 0.05, emissive: 0 },
      Left: { color: "#ffffff", roughness: 0.25, metalness: 0.05, emissive: 0 },
      Right: { color: "#ffffff", roughness: 0.25, metalness: 0.05, emissive: 0 },
      Top: { color: "#ffffff", roughness: 0.25, metalness: 0.05, emissive: 0 },
      Bottom: { color: "#ffffff", roughness: 0.25, metalness: 0.05, emissive: 0 }
    }
  };

  console.log(`Upserting premium zipper pouch GLTF template preset for slug "${slug}"...`);
  
  const template = await prisma.template.upsert({
    where: { slug },
    update: {
      name: "3 Gusset Zipper Pouch Premium GLTF",
      description: "Premium high-fidelity 3D pouch preset featuring dual zipper pullers, side and bottom gussets, and premium multi-mesh LSCM UV unwrap for seamless canvas image mapping.",
      modelFile: "3_gusset_zipper_pouch_group.gltf",
      isPublic: true,
      isDefault: true,
      editorState: JSON.stringify(editorState),
      updatedAt: new Date()
    },
    create: {
      name: "3 Gusset Zipper Pouch Premium GLTF",
      description: "Premium high-fidelity 3D pouch preset featuring dual zipper pullers, side and bottom gussets, and premium multi-mesh LSCM UV unwrap for seamless canvas image mapping.",
      modelFile: "3_gusset_zipper_pouch_group.gltf",
      isPublic: true,
      isDefault: true,
      slug,
      editorState: JSON.stringify(editorState)
    }
  });

  console.log("Upsert completed successfully!");
  console.log(`ID: ${template.id}`);
  console.log(`Name: ${template.name}`);
  console.log(`Slug: ${template.slug}`);
  console.log(`Model File: ${template.modelFile}`);
}

main()
  .catch(e => {
    console.error("Error upserting premium preset:", e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
