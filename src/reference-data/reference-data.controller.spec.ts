import { Test } from '@nestjs/testing';
import { ReferenceDataController } from './reference-data.controller';
import { ReferenceDataService } from './reference-data.service';

describe('ReferenceDataController', () => {
  let controller: ReferenceDataController;
  const service = {
    getTeachingLocations: jest.fn(),
    getLanguages: jest.fn(),
    getCourseLevelsOffered: jest.fn(),
    getExamPreparations: jest.fn(),
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    const moduleRef = await Test.createTestingModule({
      controllers: [ReferenceDataController],
      providers: [{ provide: ReferenceDataService, useValue: service }],
    }).compile();
    controller = moduleRef.get(ReferenceDataController);
  });

  it('delegates teaching-locations to the service', async () => {
    const rows = [
      { id: '1', key: 'loc.whistler', name: 'Whistler', sortOrder: 1 },
    ];
    service.getTeachingLocations.mockResolvedValue(rows);
    await expect(controller.teachingLocations()).resolves.toBe(rows);
    expect(service.getTeachingLocations).toHaveBeenCalledTimes(1);
  });

  it('delegates languages to the service', async () => {
    service.getLanguages.mockResolvedValue([]);
    await controller.languages();
    expect(service.getLanguages).toHaveBeenCalledTimes(1);
  });

  it('delegates course-levels-offered to the service', async () => {
    service.getCourseLevelsOffered.mockResolvedValue([]);
    await controller.courseLevelsOffered();
    expect(service.getCourseLevelsOffered).toHaveBeenCalledTimes(1);
  });

  it('delegates exam-preparations to the service', async () => {
    service.getExamPreparations.mockResolvedValue([]);
    await controller.examPreparations();
    expect(service.getExamPreparations).toHaveBeenCalledTimes(1);
  });
});
